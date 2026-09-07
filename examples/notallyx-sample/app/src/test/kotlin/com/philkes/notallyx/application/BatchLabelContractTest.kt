package com.philkes.notallyx.application

import android.app.Application
import android.database.sqlite.SQLiteConstraintException
import android.os.Looper
import androidx.lifecycle.Observer
import androidx.lifecycle.viewModelScope
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.philkes.notallyx.data.NotallyDatabase
import com.philkes.notallyx.data.model.*
import com.philkes.notallyx.presentation.viewmodel.BaseNoteModel
import com.philkes.notallyx.presentation.viewmodel.preference.NotallyXPreferences
import com.philkes.notallyx.utils.Event
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

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [35], application = StorageTestApplication::class)
class BatchLabelContractTest {
    private lateinit var app: Application
    private lateinit var session: DatabaseSession
    private lateinit var service: NoteApplicationService
    private lateinit var effects: RecordingNoteEffects
    private val databaseName = "batch-label-contract.sqlite"
    private val changedBatches = mutableListOf<List<BaseNote>>()
    private lateinit var ids: List<Long>
    private fun note(title: String, labels: List<String>, folder: Folder) = BaseNote(0, Type.NOTE, folder,
        "#AFCCDC", title, true, 10, 20, labels, "unchanged $title", emptyList(), emptyList(),
        emptyList(), emptyList(), emptyList(), emptyList(), NoteViewMode.EDIT, false)
    @Before fun setup() {
        app = ApplicationProvider.getApplicationContext()
        app.deleteDatabase(databaseName)
        session = DatabaseSession(app, open = { Room.databaseBuilder(app, NotallyDatabase::class.java, databaseName).build() }, reset = {})
        effects = object : RecordingNoteEffects() {
            override suspend fun changed(notes: List<BaseNote>) { changedBatches += notes.map(BaseNote::deepCopy) }
        }
        service = NoteApplicationService(app, session, effects)
        runBlocking(Dispatchers.IO) {
            listOf("common", "only-a", "only-b", "new", "external").forEach { service.addLabel(it) }
            ids = listOf(
                service.save(note("A", listOf("common", "only-a"), Folder.NOTES), false),
                service.save(note("B", listOf("common", "only-b"), Folder.ARCHIVED), false),
                service.save(note("unselected", listOf("common"), Folder.DELETED), false),
            )
            NotallyXPreferences.getInstance(app).labelsHidden.save(setOf("only-a"))
        }
        changedBatches.clear()
    }
    @After fun cleanup() { session.close(); app.deleteDatabase(databaseName) }
    private fun notes() = service.allNotes().sortedBy { it.id }
    private fun assertPreserved(before: List<BaseNote>) {
        assertEquals(before, notes())
        assertEquals(setOf("only-a"), NotallyXPreferences.getInstance(app).labelsHidden.value)
        assertTrue(changedBatches.isEmpty())
    }
    @Test fun threeStateMergePreservesUnselectedRowsAndOmittedLabelsInOneBatch() = runBlocking(Dispatchers.IO) {
        val before = notes()
        val result = service.applyLabels(longArrayOf(ids[0], ids[1], ids[0]), listOf("common", "new", "new"), setOf("only-b"))
        assertEquals(NoteApplicationService.BatchLabelResult.Applied(ids.take(2)), result)
        assertEquals(listOf(before[0].copy(labels = listOf("common", "only-a", "new")),
            before[1].copy(labels = listOf("common", "new")), before[2]), notes())
        assertEquals(listOf(ids.take(2)), changedBatches.map { batch -> batch.map { it.id } })
        assertEquals(setOf("only-a"), NotallyXPreferences.getInstance(app).labelsHidden.value)
    }
    @Test fun staleDialogChangesMergeWithLabelsAddedAfterOpening() = runBlocking(Dispatchers.IO) {
        service.setLabels(ids[0], listOf("common", "only-a", "external"))
        val before = notes(); changedBatches.clear()
        service.applyLabels(ids.take(2).toLongArray(), listOf("new"), setOf("only-b"))
        assertEquals(before[0].copy(labels = listOf("common", "only-a", "external", "new")), notes()[0])
        assertEquals(before[1].copy(labels = listOf("common", "new")), notes()[1])
        assertEquals(before[2], notes()[2])
    }
    @Test fun secondRowSqlFailureRollsBackFirstRowAndEmitsNoEffects() = runBlocking(Dispatchers.IO) {
        val before = notes()
        session.transaction { db -> db.openHelper.writableDatabase.execSQL(
            """CREATE TRIGGER reject_second BEFORE UPDATE ON BaseNote WHEN OLD.id = ${ids[1]} BEGIN
                SELECT CASE WHEN (SELECT instr(labels, '"new"') FROM BaseNote WHERE id = ${ids[0]}) > 0
                THEN RAISE(ABORT, 'batch_second_row') ELSE RAISE(ABORT, 'first_row_not_updated') END; END""") }
        try { service.applyLabels(ids.take(2).toLongArray(), listOf("new"), emptySet()); fail("Expected SQL failure") }
        catch (error: SQLiteConstraintException) { assertTrue(error.message.orEmpty().contains("batch_second_row")) }
        assertPreserved(before)
    }
    @Test fun missingNoteAndRenamedAddedLabelRejectTheWholeSelection() = runBlocking(Dispatchers.IO) {
        service.delete(longArrayOf(ids[1])); service.renameLabel("new", "renamed")
        changedBatches.clear(); val before = notes()
        assertEquals(NoteApplicationService.BatchLabelResult.StaleSelection(listOf(ids[1]), listOf("new")),
            service.applyLabels(ids.take(2).toLongArray(), listOf("new"), setOf("only-a")))
        assertPreserved(before)
    }
    @Test fun missingNoteAloneRejectsBeforeAnyWrite() = runBlocking(Dispatchers.IO) {
        service.delete(longArrayOf(ids[1])); changedBatches.clear(); val before = notes()
        assertEquals(NoteApplicationService.BatchLabelResult.StaleSelection(listOf(ids[1]), emptyList()),
            service.applyLabels(ids.take(2).toLongArray(), listOf("new"), setOf("only-a")))
        assertPreserved(before)
    }
    @Test fun missingAddedLabelAloneRejectsBeforeAnyWrite() = runBlocking(Dispatchers.IO) {
        service.renameLabel("new", "renamed"); changedBatches.clear(); val before = notes()
        assertEquals(NoteApplicationService.BatchLabelResult.StaleSelection(emptyList(), listOf("new")),
            service.applyLabels(ids.take(2).toLongArray(), listOf("new"), setOf("only-a")))
        assertPreserved(before)
    }
    @Test fun unchangedSelectionAndEmptyIdsDoNotNotifyOrWriteOtherFields() = runBlocking(Dispatchers.IO) {
        val before = notes()
        assertEquals(NoteApplicationService.BatchLabelResult.Applied(emptyList()), service.applyLabels(ids.take(2).toLongArray(), listOf("common"), emptySet()))
        assertEquals(NoteApplicationService.BatchLabelResult.Applied(emptyList()), service.applyLabels(longArrayOf(), listOf("new"), emptySet()))
        assertPreserved(before)
    }
    @Test fun contradictoryChangeIsRejectedAndRepeatedRemovedReferencesAllDisappear() = runBlocking(Dispatchers.IO) {
        val before = notes()
        try { service.applyLabels(ids.take(2).toLongArray(), listOf("new"), setOf("new")); fail("Expected invalid change") }
        catch (expected: IllegalArgumentException) { }
        assertPreserved(before)
        service.setLabels(ids[0], listOf("only-a", "common", "only-a")); changedBatches.clear()
        service.applyLabels(longArrayOf(ids[0]), emptyList(), setOf("only-a"))
        assertEquals(listOf("common"), service.note(ids[0])!!.labels)
        assertEquals(before.drop(1), notes().drop(1))
    }
    @Test fun actualViewModelCopiesIdsCommitsOnceAndClosesSelectionOnce() {
        val model = BaseNoteModel(app, service)
        val selected = runBlocking(Dispatchers.IO) { service.notes(ids.take(2).toLongArray()) }
        model.actionMode.add(selected)
        var closes = 0
        val observer = Observer<Event<Set<Long>>> { closes++ }
        model.actionMode.closeListener.observeForever(observer)
        try {
            val requestedIds = ids.take(2).toLongArray()
            model.applyBaseNoteLabels(requestedIds, listOf("new"), setOf("only-b"))
            requestedIds.fill(ids[2])
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(6)
            while (closes == 0 && System.nanoTime() < deadline) { shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(10) }
            assertEquals(1, closes)
            assertTrue(model.actionMode.isEmpty())
            runBlocking(Dispatchers.IO) {
                assertEquals(listOf("common", "only-a", "new"), service.note(ids[0])!!.labels)
                assertEquals(listOf("common", "new"), service.note(ids[1])!!.labels)
                assertEquals(listOf("common"), service.note(ids[2])!!.labels)
            }
            assertEquals(listOf(ids.take(2)), changedBatches.map { batch -> batch.map { it.id } })
        } finally { model.actionMode.closeListener.removeObserver(observer); model.viewModelScope.cancel() }
    }
    @Test fun committedEffectsHoldGateAndFailureDoesNotPretendSqlRolledBack() = runBlocking(Dispatchers.IO) {
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        val blocking = NoteApplicationService(app, session, object : RecordingNoteEffects() {
            override suspend fun changed(notes: List<BaseNote>) {
                val persisted = service.notes(ids.take(2).toLongArray())
                assertTrue(persisted.all { "new" in it.labels })
                entered.complete(Unit); release.await(); error("effect_after_commit")
            }
        })
        supervisorScope {
            val change = async { runCatching { blocking.applyLabels(ids.take(2).toLongArray(), listOf("new"), emptySet()) } }
            entered.await()
            val deleted = async(start = CoroutineStart.UNDISPATCHED) { service.deleteLabel("new") }
            assertFalse("Other operation must wait for post-commit effects", deleted.isCompleted)
            release.complete(Unit)
            assertEquals("effect_after_commit", change.await().exceptionOrNull()?.message)
            deleted.await()
        }
        assertFalse(service.labelExists("new"))
        assertTrue(service.allNotes().none { "new" in it.labels })
    }
}
