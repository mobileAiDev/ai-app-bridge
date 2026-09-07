package com.philkes.notallyx.application

import android.app.Application
import android.os.Looper
import androidx.lifecycle.viewModelScope
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.philkes.notallyx.data.NotallyDatabase
import com.philkes.notallyx.data.model.*
import com.philkes.notallyx.presentation.viewmodel.BaseNoteModel
import com.philkes.notallyx.presentation.viewmodel.preference.NotallyXPreferences
import com.philkes.notallyx.presentation.viewmodel.preference.NotallyXPreferences.Companion.START_VIEW_DEFAULT
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** Real Room transactions and the actual BaseNoteModel callback path; no DAO/service mocks. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [35], application = StorageTestApplication::class)
class LabelMutationContractTest {
    private lateinit var app: Application
    private lateinit var session: DatabaseSession
    private lateinit var service: NoteApplicationService
    private lateinit var model: BaseNoteModel
    private lateinit var preferences: NotallyXPreferences
    private val databaseName = "label-contract.sqlite"

    @Before fun setup() {
        app = ApplicationProvider.getApplicationContext()
        app.deleteDatabase(databaseName)
        session = DatabaseSession(app, open = { Room.databaseBuilder(app, NotallyDatabase::class.java, databaseName).build() }, reset = {})
        service = NoteApplicationService(app, session, RecordingNoteEffects())
        model = BaseNoteModel(app, service)
        preferences = NotallyXPreferences.getInstance(app)
        runBlocking(Dispatchers.IO) {
            service.addLabel("old")
            service.addLabel("occupied")
            service.addLabel("unrelated")
            for (folder in Folder.entries) service.save(note(folder).copy(labels = listOf("old", "unrelated")), false)
            service.save(note(Folder.NOTES).copy(title = "untouched", labels = listOf("occupied")), false)
            preferences.labelsHidden.save(setOf("old", "occupied"))
            preferences.startView.save("old")
        }
        shadowOf(Looper.getMainLooper()).idle()
    }
    @After fun cleanup() { model.viewModelScope.cancel(); session.close(); app.deleteDatabase(databaseName) }
    private fun note(folder: Folder) = BaseNote(0, Type.NOTE, folder, "#AFCCDC", folder.name, true, 10, 20,
        emptyList(), "unchanged body ${folder.name}", emptyList(), emptyList(), emptyList(), emptyList(), emptyList(), emptyList(), NoteViewMode.EDIT, false)
    private fun notes() = runBlocking(Dispatchers.IO) { service.allNotes().sortedBy { it.id } }
    private fun labelRows() = runBlocking(Dispatchers.IO) { session.read { db ->
        db.openHelper.readableDatabase.query("SELECT value, `order` FROM Label ORDER BY `order`").use { cursor ->
            buildList { while (cursor.moveToNext()) add(cursor.getString(0) to cursor.getInt(1)) }
        }
    } }
    private fun callback(action: ((Boolean) -> Unit) -> Unit): Boolean {
        val results = mutableListOf<Boolean>()
        action { value -> assertEquals(Looper.getMainLooper(), Looper.myLooper()); results += value }
        pumpUntil { results.isNotEmpty() }
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals("Exactly one completion callback", 1, results.size)
        return results.single()
    }
    private fun assertFailurePreserved(before: List<BaseNote>, labels: List<Pair<String, Int>>) {
        assertEquals(before, notes()); assertEquals(labels, labelRows())
        assertEquals(setOf("old", "occupied"), preferences.labelsHidden.value)
        assertEquals("old", preferences.startView.value)
    }
    @Test fun duplicateAddReturnsFalseOnceAndPreservesEveryNoteAndLabel() {
        val before = notes(); val labels = labelRows()
        assertFalse(callback { model.insertLabel("old", it) })
        assertFailurePreserved(before, labels)
    }
    @Test fun renameConflictReturnsFalseAndPreservesAllFoldersReferencesOrderAndPreferences() {
        val before = notes(); val labels = labelRows()
        assertFalse(callback { model.updateLabel("old", "occupied", it) })
        assertFailurePreserved(before, labels)
    }
    @Test fun renameUpdatesAllFoldersAndThenDeleteRemovesEveryReferenceWithoutChangingOtherFields() {
        val before = notes(); val labels = labelRows()
        assertTrue(callback { model.updateLabel("old", "renamed", it) })
        assertEquals(before.map { note -> note.copy(labels = note.labels.map { if (it == "old") "renamed" else it }) }, notes())
        assertEquals(labels.map { (value, order) -> (if (value == "old") "renamed" else value) to order }, labelRows())
        assertEquals(setOf("renamed", "occupied"), preferences.labelsHidden.value)
        assertEquals("renamed", preferences.startView.value)
        model.deleteLabel("renamed")
        pumpUntil { runBlocking(Dispatchers.IO) { !service.labelExists("renamed") } && preferences.startView.value == START_VIEW_DEFAULT }
        assertEquals(before.map { it.copy(labels = it.labels - "old") }, notes())
        assertEquals(labels.filterNot { it.first == "old" }, labelRows())
        assertEquals(setOf("occupied"), preferences.labelsHidden.value)
    }
    @Test fun sameNameRenameSucceedsWithoutMovingLabelOrChangingReferences() {
        val before = notes(); val labels = labelRows()
        assertTrue(callback { model.updateLabel("old", "old", it) })
        assertFailurePreserved(before, labels)
    }
    @Test fun actualSqlConstraintRollsBackEarlierReferenceUpdatesAndDoesNotCommitPreferences() {
        val before = notes(); val labels = labelRows()
        runBlocking(Dispatchers.IO) { session.transaction { db ->
            db.openHelper.writableDatabase.execSQL("CREATE TRIGGER fail_label BEFORE UPDATE ON Label BEGIN SELECT RAISE(ABORT, 'contract_injected_constraint'); END")
        } }
        assertFalse(callback { model.updateLabel("old", "renamed", it) })
        assertFailurePreserved(before, labels)
    }
    @Test fun deletingLabelRemovesRepeatedImportedReferencesAndPreservesOtherFields() = runBlocking(Dispatchers.IO) {
        service.save(note(Folder.ARCHIVED).copy(labels = listOf("old", "unrelated", "old", "occupied")), false)
        val before = service.allNotes().sortedBy { it.id }
        service.deleteLabel("old")
        assertEquals(before.map { note -> note.copy(labels = note.labels.filterNot { it == "old" }) },
            service.allNotes().sortedBy { it.id })
        assertFalse(service.labelExists("old"))
    }
    private fun pumpUntil(condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(6)
        while (!condition() && System.nanoTime() < deadline) { shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(10) }
        assertTrue("Callback or committed postcondition did not arrive", condition())
    }
}
