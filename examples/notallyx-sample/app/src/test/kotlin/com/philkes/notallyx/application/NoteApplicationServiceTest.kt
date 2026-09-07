package com.philkes.notallyx.application

import android.app.Application
import android.os.Looper
import androidx.lifecycle.Observer
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.philkes.notallyx.data.NotallyDatabase
import com.philkes.notallyx.data.model.*
import com.philkes.notallyx.utils.getPrivateAttachmentsRoot
import com.philkes.notallyx.utils.getPrivateFilesDirectory
import com.philkes.notallyx.utils.getExternalMediaDirectory
import com.philkes.notallyx.utils.SUBFOLDER_FILES
import com.philkes.notallyx.utils.resolveAttachmentFile
import com.philkes.notallyx.presentation.viewmodel.preference.NotallyXPreferences
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

class StorageTestApplication : Application() {
    override fun getExternalMediaDirs(): Array<java.io.File> = arrayOf(java.io.File(filesDir, "test-public-media").apply { mkdirs() })
}

internal open class RecordingNoteEffects : NoteEffects {
    val events = java.util.Collections.synchronizedList(mutableListOf<String>())
    override suspend fun saved(previous: BaseNote?, note: BaseNote, backup: Boolean) { events += "saved:${note.id}" }
    override suspend fun changed(notes: List<BaseNote>) { events += "changed" }
    override suspend fun moved(notes: List<BaseNote>, folder: Folder) { events += "moved:$folder" }
    override suspend fun deleted(notes: List<BaseNote>, files: Boolean, backup: Boolean) { events += "deleted" }
}

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [35], application = StorageTestApplication::class)
class NoteApplicationServiceTest {
    private lateinit var app: Application
    private lateinit var db: NotallyDatabase
    private lateinit var session: DatabaseSession
    private lateinit var service: NoteApplicationService
    private lateinit var effects: RecordingNoteEffects
    private var failingOpens = 0
    private val databaseName = "application-service-test.sqlite"

    @Before fun setup() {
        app = ApplicationProvider.getApplicationContext()
        app.deleteDatabase(databaseName)
        effects = RecordingNoteEffects()
        session = DatabaseSession(app, open = {
            if (failingOpens > 0) { failingOpens--; error("injected reopen failure") }
            Room.databaseBuilder(app, NotallyDatabase::class.java, databaseName).build().also { db = it }
        }, reset = {})
        service = NoteApplicationService(app, session, effects)
    }
    @After fun cleanup() { session.close(); app.deleteDatabase(databaseName) }

    private fun note(title: String = "Original") = BaseNote(0, Type.NOTE, Folder.NOTES,
        BaseNote.COLOR_DEFAULT, title, false, 10, 11, emptyList(), "body", emptyList(), emptyList(),
        emptyList(), emptyList(), emptyList(), emptyList(), NoteViewMode.EDIT, false)

    @Test fun nestedImportCompletesAndSkipsExistingNoteWhileRestoringMissingNote() = runBlocking(Dispatchers.IO) {
        val existingId = service.save(note("existing"), false)
        val original = service.note(existingId)!!
        val missing = note("missing").copy(id = 800)
        withTimeout(3000) {
            session.operation {
                withContext(Dispatchers.IO) {
                    val result = service.importNotes(listOf(original, missing), emptyList(), 0, true, listOf(original.id, missing.id))
                    assertEquals(1, result.inserted)
                    assertEquals(1, result.duplicates)
                }
            }
        }
        assertEquals(original, service.note(existingId))
        assertEquals(2, service.allNotes().size)
        val restored = service.allNotes().single { it.title == "missing" }
        assertNotEquals(missing.id, restored.id)
        assertEquals(missing.copy(id = restored.id), restored)
    }

    @Test fun archiveFailureClosesProgressAndPreservesOriginalIoErrorAcrossStorageDispatcher() {
        val progress = androidx.lifecycle.MutableLiveData<com.philkes.notallyx.presentation.view.misc.Progress>()
        val missing = java.io.File(app.cacheDir, "missing-backup.zip").apply { delete() }
        val directory = java.io.File(app.cacheDir, "archive-loop").apply { mkdirs() }
        val operation = CompletableFuture.supplyAsync {
            runBlocking {
                runCatching { service.importArchive(android.net.Uri.fromFile(missing), directory, "", true, progress) }.exceptionOrNull()
            }
        }
        pumpUntil { operation.isDone }
        val failure = operation.get(2, TimeUnit.SECONDS)
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue("Expected original file error, got $failure", failure is java.io.FileNotFoundException)
        assertEquals(false, progress.value?.inProgress)
        directory.deleteRecursively()
    }

    @Test fun failedLabelRenameRollsBackNotesAndDoesNotChangePreferences() = runBlocking(Dispatchers.IO) {
        service.addLabel("old")
        val id = service.save(note().copy(labels = listOf("old")), false)
        val preferences = NotallyXPreferences.getInstance(app)
        preferences.labelsHidden.save(setOf("old"))
        preferences.startView.save("old")
        db.openHelper.writableDatabase.execSQL("CREATE TRIGGER reject_label BEFORE UPDATE ON Label BEGIN SELECT RAISE(ABORT, 'label_failure'); END")
        try { service.renameLabel("old", "new"); fail("Rename should fail") }
        catch (expected: Exception) { assertTrue(expected.message.orEmpty().contains("label_failure")) }
        assertEquals(listOf("old"), service.note(id)!!.labels)
        assertTrue(service.labelExists("old"))
        assertFalse(service.labelExists("new"))
        assertEquals(setOf("old"), preferences.labelsHidden.value)
        assertEquals("old", preferences.startView.value)
    }

    @Test fun invalidTaskPositionDoesNotCommitOrEmitEffects() = runBlocking(Dispatchers.IO) {
        val id = service.save(note().copy(type = Type.LIST, items = listOf(ListItem("parent", false, false, 0, mutableListOf()))), false)
        effects.events.clear()
        try { service.checkItem(id, 12, true); fail("Missing position should fail") }
        catch (expected: IllegalArgumentException) { }
        assertFalse(service.note(id)!!.items.single().checked)
        assertTrue(effects.events.isEmpty())
    }

    @Test fun childrenAreUpdatedAtomicallyAndUnrelatedContentSurvives() = runBlocking(Dispatchers.IO) {
        val items = listOf(ListItem("parent", false, false, 0, mutableListOf()),
            ListItem("child 1", false, true, 1, mutableListOf()), ListItem("child 2", false, true, 2, mutableListOf()))
        val id = service.save(note().copy(type = Type.LIST, items = items), false)
        coroutineScope { launch { service.checkItem(id, 1, true) }; launch { service.checkItem(id, 2, true) } }
        val actual = service.note(id)!!
        assertTrue(actual.items.all { it.checked })
        assertEquals("body", actual.body)
        assertEquals("Original", actual.title)
    }

    @Test fun deleteWaitsForMovePostCommitEffects() = runBlocking(Dispatchers.IO) {
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val orderedEffects = object : RecordingNoteEffects() {
            override suspend fun moved(notes: List<BaseNote>, folder: Folder) {
                assertEquals(folder, service.note(notes.single().id)!!.folder)
                entered.complete(Unit)
                release.await()
                super.moved(notes, folder)
            }
        }
        service = NoteApplicationService(app, session, orderedEffects)
        val id = service.save(note(), false)
        val move = launch { service.move(longArrayOf(id), Folder.ARCHIVED) }
        entered.await()
        val deletion = launch { service.delete(longArrayOf(id)) }
        delay(80)
        assertFalse(deletion.isCompleted)
        release.complete(Unit)
        withTimeout(3000) { move.join(); deletion.join() }
        assertNull(service.note(id))
        assertTrue(orderedEffects.events.indexOf("moved:ARCHIVED") < orderedEffects.events.indexOf("deleted"))
    }

    @Test fun failedMaintenanceReopensOriginalAndActiveObserverFollowsNewHandle() {
        val id = runBlocking(Dispatchers.IO) { service.save(note(), false) }
        val observed = mutableListOf<String>()
        val live = service.observeNote(id)
        val observer = Observer<BaseNote?> { it?.let { observed += it.title } }
        live.observeForever(observer)
        pumpUntil { observed.contains("Original") }
        val old = db
        val maintenance = CompletableFuture.runAsync { runBlocking {
            try { session.maintenance { error("injected maintenance failure") }; fail("Failure expected") }
            catch (expected: IllegalStateException) { assertEquals("injected maintenance failure", expected.message) }
        } }
        pumpUntil { maintenance.isDone }
        maintenance.get(2, TimeUnit.SECONDS)
        assertNotSame(old, db)
        assertFalse(old.isOpen)
        runBlocking(Dispatchers.IO) { service.save(requireNotNull(service.note(id)).copy(title = "After reopen"), false) }
        pumpUntil { observed.contains("After reopen") }
        live.removeObserver(observer)
        assertFalse(live.hasActiveObservers())
    }

    @Test fun replacementOpenFailureRunsRollbackBeforeReopeningOriginal() {
        val id = runBlocking(Dispatchers.IO) { service.save(note(), false) }
        var selected = "original"
        val operation = CompletableFuture.runAsync { runBlocking {
            try {
                session.maintenance(rollback = { selected = "original" }) {
                    selected = "replacement"
                    failingOpens = 1
                }
                fail("First reopen should fail")
            } catch (expected: IllegalStateException) { assertEquals("injected reopen failure", expected.message) }
        } }
        pumpUntil { operation.isDone }; operation.get(2, TimeUnit.SECONDS)
        assertEquals("original", selected)
        assertEquals("Original", runBlocking(Dispatchers.IO) { service.note(id)!!.title })
    }

    @Test fun activeSearchFlowFollowsReopenedDatabaseWithoutChangingQuery() {
        val id = runBlocking(Dispatchers.IO) { service.save(note(), false) }
        val titles = java.util.Collections.synchronizedList(mutableListOf<String>())
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val collector = scope.launch { service.search("body", Folder.NOTES, null).collect { notes -> titles.addAll(notes.map { it.title }) } }
        try {
            pumpUntil { titles.contains("Original") }
            val reopen = CompletableFuture.runAsync { runBlocking { session.maintenance { } } }
            pumpUntil { reopen.isDone }; reopen.get(2, TimeUnit.SECONDS)
            runBlocking(Dispatchers.IO) { service.save(requireNotNull(service.note(id)).copy(title = "Reopened flow"), false) }
            pumpUntil { titles.contains("Reopened flow") }
        } finally {
            collector.cancel(); scope.cancel()
            pumpUntil { collector.isCompleted }
        }
    }

    @Test fun postCommitNotificationFailureDoesNotDeleteImportedAttachment() = runBlocking(Dispatchers.IO) {
        val id = service.save(note(), false)
        val input = app.cacheDir.resolve("source-attachment.txt").apply { writeText("attachment must survive notification failure") }
        service = NoteApplicationService(app, session, object : RecordingNoteEffects() {
            override suspend fun changed(notes: List<BaseNote>) { error("notification effect failed") }
        })
        try {
            try {
                service.importAttachments(id, arrayOf(android.net.Uri.fromFile(input)), FileType.ANY) { _, _ -> }
                fail("Notification effect should fail")
            } catch (expected: IllegalStateException) { assertEquals("notification effect failed", expected.message) }
            val attachment = service.note(id)!!.files.single()
            assertEquals(input.readText(), app.resolveAttachmentFile(SUBFOLDER_FILES, attachment.localName)!!.readText())
        } finally { input.delete() }
    }

    @Test fun sharedAttachmentSurvivesUntilLastReferenceAndBothStorageCopiesAreDeleted() = runBlocking(Dispatchers.IO) {
        val attachment = FileAttachment("shared.txt", "shared.txt", "text/plain")
        val privateFile = app.getPrivateFilesDirectory().resolve(attachment.localName).apply { writeText("shared") }
        val publicFile = app.getExternalMediaDirectory().resolve(SUBFOLDER_FILES).apply { mkdirs() }.resolve(attachment.localName).apply { writeText("shared") }
        val one = service.save(note("one").copy(files = listOf(attachment)), false)
        val two = service.save(note("two").copy(files = listOf(attachment)), false)
        service.removeAttachments(one, listOf(attachment))
        assertTrue(privateFile.exists()); assertTrue(publicFile.exists())
        service.removeAttachments(two, listOf(attachment))
        assertFalse(privateFile.exists()); assertFalse(publicFile.exists())
    }

    @Test fun storageRoundTripAndDuplicateConcurrentMoveKeepNewestDatabase() {
        session.close()
        val preferences = NotallyXPreferences.getInstance(app)
        preferences.dataInPublicFolder.save(false)
        val internal = NotallyDatabase.getInternalDatabaseFile(app)
        val external = NotallyDatabase.getExternalDatabaseFile(app)
        fun openFile(file: java.io.File) = Room.databaseBuilder(app, NotallyDatabase::class.java, file.path).build()
        session = DatabaseSession(app, open = { openFile(NotallyDatabase.getCurrentDatabaseFile(app)).also { db = it } }, reset = {})
        service = NoteApplicationService(app, session, effects)
        val maintenance = StorageMaintenance(app, session) { public -> openFile(if (public) external else internal) }
        val id = runBlocking(Dispatchers.IO) { service.save(note(), false) }
        val attachment = app.getPrivateFilesDirectory().resolve("migration-fixture.txt").apply { writeText("attachment-original") }
        fun move(public: Boolean, twice: Boolean = false) {
            val task = CompletableFuture.runAsync { runBlocking {
                coroutineScope {
                    launch { maintenance.moveData(public) }
                    if (twice) launch { maintenance.moveData(public) }
                }
            } }
            pumpUntil { task.isDone }; task.get(2, TimeUnit.SECONDS)
        }
        try {
            move(true, twice = true)
            assertEquals("attachment-original", app.getExternalMediaDirectory().resolve(SUBFOLDER_FILES).apply { mkdirs() }.resolve(attachment.name).readText())
            move(false)
            assertFalse(app.getPrivateAttachmentsRoot().resolve(StorageMaintenance.DATABASE_NAME).exists())
            runBlocking(Dispatchers.IO) { service.save(requireNotNull(service.note(id)).copy(title = "Newest edit"), false) }
            move(true)
            assertEquals("Newest edit", runBlocking(Dispatchers.IO) { service.note(id)!!.title })
            assertEquals("attachment-original", attachment.readText())
        } finally {
            session.close()
            listOf(internal, external).forEach { file -> file.delete(); java.io.File(file.path + "-wal").delete(); java.io.File(file.path + "-shm").delete() }
            attachment.delete(); app.getExternalMediaDirectory().resolve(SUBFOLDER_FILES).apply { mkdirs() }.resolve(attachment.name).delete()
            preferences.dataInPublicFolder.save(false)
        }
    }

    @Test fun failedRecoveryParsePreservesAllOriginalData() = runBlocking(Dispatchers.IO) {
        val id = service.save(note(), false)
        val invalid = app.cacheDir.resolve("invalid-recovery.sqlite").apply { writeText("not sqlite") }
        try {
            service.replaceFromDatabase(android.net.Uri.fromFile(invalid), null)
            fail("Invalid source must fail")
        } catch (expected: Exception) { assertEquals("Original", service.note(id)!!.title) }
        finally { invalid.delete() }
    }

    private fun pumpUntil(condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8)
        while (!condition() && System.nanoTime() < deadline) { shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(10) }
        assertTrue("Timed out waiting for database lifecycle", condition())
    }
}
