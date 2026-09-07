package com.philkes.notallyx.application

import android.app.Application
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.database.sqlite.SQLiteConstraintException
import android.net.Uri
import com.philkes.notallyx.data.model.FileType
import androidx.lifecycle.MutableLiveData
import com.philkes.notallyx.presentation.view.misc.Progress
import com.philkes.notallyx.data.imports.NotesImporter
import com.philkes.notallyx.data.imports.ImportSource
import com.philkes.notallyx.utils.backup.*
import androidx.lifecycle.LiveData
import com.philkes.notallyx.R
import com.philkes.notallyx.data.imports.ImportResult
import com.philkes.notallyx.data.model.*
import com.philkes.notallyx.presentation.activity.note.reminders.ReminderReceiver
import com.philkes.notallyx.presentation.viewmodel.preference.NotallyXPreferences
import com.philkes.notallyx.presentation.viewmodel.preference.NotallyXPreferences.Companion.START_VIEW_DEFAULT
import com.philkes.notallyx.presentation.widget.WidgetProvider
import com.philkes.notallyx.utils.*
import com.philkes.notallyx.utils.backup.checkBackupOnSave
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withContext

/** All note entry points share transactions and post-commit effects, including widgets and workers. */
class NoteApplicationService internal constructor(
    private val app: ContextWrapper,
    internal val session: DatabaseSession,
    private val effects: NoteEffects = AndroidNoteEffects(app),
) {
    val maintenance = StorageMaintenance(app, session)
    private val preferences get() = NotallyXPreferences.getInstance(app)

    fun note(id: Long): BaseNote? = session.read { it.getBaseNoteDao().get(id)?.deepCopy() }
    fun notes(ids: LongArray): List<BaseNote> = session.read { it.getBaseNoteDao().getByIds(ids).map(BaseNote::deepCopy) }
    fun allNotes(): List<BaseNote> = session.read { it.getBaseNoteDao().getAll().map(BaseNote::deepCopy) }
    fun images(id: Long): List<FileAttachment> = note(id)?.images.orEmpty()
    fun color(id: Long): String? = session.read { it.getBaseNoteDao().getColorOfNote(id) }
    fun observeNote(id: Long): LiveData<BaseNote?> = session.observe { it.getBaseNoteDao().observe(id) }
    fun observeNotes(): LiveData<List<BaseNote>> = session.observe { it.getBaseNoteDao().getAllAsync() }
    fun observeFolder(folder: Folder): LiveData<List<BaseNote>> = session.observe { it.getBaseNoteDao().getFrom(folder) }
    fun observeLabels(): LiveData<List<Label>> = session.observe { it.getLabelDao().getAll() }
    fun observeReminders() = session.observe { it.getBaseNoteDao().getAllRemindersAsync() }
    fun observeNotesWithReminders() = session.observe { it.getBaseNoteDao().getAllBaseNotesWithReminders() }
    fun observeLabel(label: String): Flow<List<BaseNote>> = session.observeFlow { it.getBaseNoteDao().getBaseNotesByLabel(label) }
    fun observeUnlabeled(folder: Folder): Flow<List<BaseNote>> = session.observeFlow { it.getBaseNoteDao().getBaseNotesWithoutLabel(folder) }
    fun search(keyword: String, folder: Folder, label: String?): Flow<List<BaseNote>> =
        session.observeFlow { it.getBaseNoteDao().getBaseNotesByKeyword(keyword, folder, label) }
    suspend fun activeNotes() = session.transaction { it.getBaseNoteDao().getAllNotes() }
    suspend fun pinnedToStatusNotes() = session.transaction { it.getBaseNoteDao().getAllPinnedToStatusNotes() }
    suspend fun reminders() = session.transaction { it.getBaseNoteDao().getAllReminders() }
    suspend fun colors() = session.transaction { it.getBaseNoteDao().getAllColors() }
    suspend fun labels() = session.transaction { it.getLabelDao().getArrayOfAll() }
    suspend fun labelExists(value: String) = session.transaction { it.getLabelDao().exists(value) }

    suspend fun save(note: BaseNote, backup: Boolean = true): Long = session.operation {
        val oldAndSaved = session.transaction { db ->
            val dao = db.getBaseNoteDao()
            val old = if (note.id == 0L) null else dao.get(note.id)
            val id = dao.insertSafe(app, note)
            old to requireNotNull(dao.get(id)) { "Saved note $id could not be read back" }
        }
        effects.saved(oldAndSaved.first, oldAndSaved.second, backup)
        oldAndSaved.second.id
    }

    suspend fun saveAll(notes: List<BaseNote>): List<Long> = session.operation {
        val saved = session.transaction { db ->
            val ids = db.getBaseNoteDao().insert(notes)
            ids.map { requireNotNull(db.getBaseNoteDao().get(it)) }
        }
        effects.changed(saved)
        saved.map { it.id }
    }

    suspend fun move(ids: LongArray, folder: Folder) = session.operation {
        val moved = session.transaction { db ->
            val dao = db.getBaseNoteDao()
            if (folder == Folder.DELETED) dao.move(ids, folder, System.currentTimeMillis()) else dao.move(ids, folder)
            dao.getByIds(ids)
        }
        effects.moved(moved, folder)
    }

    /** Returns the deleted snapshots for UI undo. File deletion happens only after SQL succeeds. */
    suspend fun delete(ids: LongArray, deleteFiles: Boolean = false, backup: Boolean = false): List<BaseNote> = session.operation {
        val removed = session.transaction { db ->
            val dao = db.getBaseNoteDao()
            val notes = dao.getByIds(ids)
            dao.delete(ids)
            notes
        }
        effects.deleted(if (deleteFiles) unreferencedAttachments(removed) else removed, deleteFiles, backup)
        removed
    }

    suspend fun deleteAll() = session.operation {
        val removed = session.transaction { db ->
            val notes = db.getBaseNoteDao().getAll()
            db.getBaseNoteDao().delete(notes.map { it.id }.toLongArray())
            db.getLabelDao().deleteAll()
            notes
        }
        effects.deleted(unreferencedAttachments(removed), true, false)
        preferences.startView.save(START_VIEW_DEFAULT)
    }

    suspend fun emptyTrash(beforeMs: Long? = null): Int = session.operation {
        val removed = session.transaction { db ->
            val dao = db.getBaseNoteDao()
            val ids = if (beforeMs == null) dao.getDeletedNoteIds() else dao.getDeletedNoteIdsOlderThan(beforeMs)
            val notes = dao.getByIds(ids)
            dao.delete(ids)
            notes
        }
        effects.deleted(unreferencedAttachments(removed), true, false)
        removed.size
    }

    suspend fun duplicate(notes: Collection<BaseNote>): List<Long> {
        val now = System.currentTimeMillis()
        val copies = notes.map { original -> original.deepCopy().copy(
            id = 0, title = if (original.title.isEmpty()) app.getString(R.string.copy)
                else "${original.title} (${app.getString(R.string.copy)})",
            timestamp = now, modifiedTimestamp = now,
        ) }
        return saveAll(copies)
    }

    suspend fun pin(ids: LongArray, pinned: Boolean) = update(ids) { it.copy(pinned = pinned) }
    suspend fun pinToStatus(ids: LongArray, pinned: Boolean) = update(ids) { it.copy(isPinnedToStatus = pinned) }
    suspend fun color(ids: LongArray, color: String) = update(ids) { it.copy(color = color) }
    suspend fun changeColor(old: String, new: String) = session.operation {
        val changed = session.transaction { db ->
            val dao = db.getBaseNoteDao()
            val ids = dao.getAll().filter { it.color == old }.map { it.id }.toLongArray()
            dao.updateColor(old, new)
            dao.getByIds(ids)
        }
        if (preferences.defaultNoteColor.value == old) preferences.defaultNoteColor.save(new)
        effects.changed(changed)
    }
    suspend fun setLabels(id: Long, labels: List<String>) = update(longArrayOf(id)) { it.copy(labels = labels.toList()) }

    sealed interface BatchLabelResult {
        data class Applied(val changedIds: List<Long>) : BatchLabelResult
        data class StaleSelection(val missingNoteIds: List<Long>, val missingLabels: List<String>) : BatchLabelResult
    }

    /** Merge explicit tri-state changes into current rows in one transaction; omitted labels stay unchanged. */
    suspend fun applyLabels(ids: LongArray, add: List<String>, remove: Set<String>): BatchLabelResult {
        val selectedIds = ids.distinct()
        val addedLabels = add.distinct()
        val removedLabels = remove.toSet()
        require(addedLabels.none { it in removedLabels }) { "A label cannot be added and removed together" }
        if (selectedIds.isEmpty()) return BatchLabelResult.Applied(emptyList())
        return session.operation {
            val committed: Pair<BatchLabelResult, List<BaseNote>> = session.transaction { db ->
                val dao = db.getBaseNoteDao()
                val current = dao.getByIds(selectedIds.toLongArray()).associateBy { it.id }
                val missingIds = selectedIds.filterNot(current::containsKey)
                val availableLabels = db.getLabelDao().getArrayOfAll().toSet()
                val missingLabels = addedLabels.filterNot { it in availableLabels }
                if (missingIds.isNotEmpty() || missingLabels.isNotEmpty()) {
                    return@transaction BatchLabelResult.StaleSelection(missingIds, missingLabels) to emptyList()
                }
                val changed = selectedIds.mapNotNull { id ->
                    val note = current.getValue(id)
                    val labels = note.labels.filterNot { it in removedLabels }.toMutableList()
                    addedLabels.forEach { if (it !in labels) labels.add(it) }
                    if (labels == note.labels) null else note.copy(labels = labels)
                }
                dao.updateAll(changed)
                BatchLabelResult.Applied(changed.map { it.id }) to changed
            }
            if (committed.second.isNotEmpty()) effects.changed(committed.second)
            committed.first
        }
    }
    suspend fun setImages(id: Long, images: List<FileAttachment>) = update(longArrayOf(id)) { it.copy(images = images.toList()) }
    suspend fun setFiles(id: Long, files: List<FileAttachment>) = update(longArrayOf(id)) { it.copy(files = files.toList()) }
    suspend fun setAudios(id: Long, audios: List<Audio>) = update(longArrayOf(id)) { it.copy(audios = audios.toList()) }
    suspend fun setReminders(id: Long, reminders: List<Reminder>, notify: Boolean = true): List<BaseNote> {
        if (notify) return update(longArrayOf(id)) { it.copy(reminders = reminders.map { r -> r.copy() }) }
        return session.transaction { db ->
            val dao = db.getBaseNoteDao()
            dao.updateReminders(id, reminders)
            dao.getByIds(longArrayOf(id))
        }
    }

    private suspend fun update(ids: LongArray, transform: (BaseNote) -> BaseNote): List<BaseNote> = session.operation {
        val updated = session.transaction { db ->
            val dao = db.getBaseNoteDao()
            val changed = dao.getByIds(ids).map(transform)
            dao.updateAll(changed)
            changed
        }
        effects.changed(updated)
        updated
    }

    /** Parent and child check states are derived and committed together for every entry point. */
    suspend fun checkItem(noteId: Long, position: Int, checked: Boolean?) {
        update(longArrayOf(noteId)) { note ->
            require(position in note.items.indices) { "Task position $position is no longer present" }
            val items = note.items.map { it.copy() }
            val value = checked ?: !items[position].checked
            val item = items[position]
            if (item.isChild) {
                item.checked = value
                val parent = requireNotNull((position - 1 downTo 0).firstOrNull { !items[it].isChild })
                items[parent].checked = (parent + 1 until items.size).takeWhile { items[it].isChild }.all { items[it].checked }
            } else {
                item.checked = value
                (position + 1 until items.size).takeWhile { items[it].isChild }.forEach { items[it].checked = value }
            }
            note.copy(items = items)
        }
    }

    suspend fun addLabel(value: String) {
        session.transaction { db ->
            val labels = db.getLabelDao()
            if (labels.exists(value)) throw SQLiteConstraintException("Label already exists: $value")
            labels.insert(Label(value, (labels.getMaxOrder() ?: -1) + 1))
        }
    }
    suspend fun reorderLabels(labels: List<Label>) = session.transaction { it.getLabelDao().update(labels) }
    suspend fun deleteLabel(value: String) = session.operation {
        session.transaction { db ->
            val dao = db.getBaseNoteDao()
            dao.updateAll(dao.getAll().filter { value in it.labels }.map { note -> note.copy(labels = note.labels.filterNot { it == value }) })
            db.getLabelDao().delete(value)
        }
        preferences.labelsHidden.save(preferences.labelsHidden.value - value)
        if (preferences.startView.value == value) preferences.startView.save(START_VIEW_DEFAULT)
    }
    suspend fun renameLabel(old: String, new: String) = session.operation {
        session.transaction { db ->
            if (old != new && db.getLabelDao().exists(new)) throw SQLiteConstraintException("Label already exists: $new")
            val dao = db.getBaseNoteDao()
            dao.updateAll(dao.getAll().filter { old in it.labels }.map { note -> note.copy(labels = note.labels.map { if (it == old) new else it }) })
            db.getLabelDao().update(old, new)
        }
        val hidden = preferences.labelsHidden.value
        if (old in hidden) preferences.labelsHidden.save(hidden - old + new)
        if (preferences.startView.value == old) preferences.startView.save(new)
    }

    suspend fun importNotes(notes: List<BaseNote>, labels: List<Label>, corrupted: Int, duplicates: Boolean,
        originalIds: List<Long>? = null): ImportResult = session.operation {
        val result = session.transaction { db ->
            if (originalIds == null) db.getCommonDao().importBackup(notes, labels, corrupted, duplicates)
            else db.getCommonDao().importBackup(notes, originalIds, labels, corrupted, duplicates)
        }
        val imported = allNotes()
        effects.moved(imported.filter { it.folder == Folder.NOTES }, Folder.NOTES)
        result
    }

    private fun Attachment.storageKey(): String = when (this) {
        is Audio -> "$SUBFOLDER_AUDIOS/$name"
        is FileAttachment -> "${if (isImage) SUBFOLDER_IMAGES else SUBFOLDER_FILES}/$localName"
    }

    private fun unreferencedAttachments(removed: List<BaseNote>): List<BaseNote> {
        val referenced = allNotes().flatMap { it.images + it.files + it.audios }.map { it.storageKey() }.toSet()
        return removed.map { note -> note.copy(
            images = note.images.filterNot { it.storageKey() in referenced },
            files = note.files.filterNot { it.storageKey() in referenced },
            audios = note.audios.filterNot { it.storageKey() in referenced },
        ) }
    }

    data class AttachmentImport(val note: BaseNote, val errors: List<FileError>)

    suspend fun importAttachments(id: Long, uris: Array<Uri>, type: FileType,
        progress: (Int, Int) -> Unit): AttachmentImport = session.operation {
        requireNotNull(note(id)) { "Note $id no longer exists" }
        val directory = requireNotNull(if (type == FileType.IMAGE) app.getCurrentImagesDirectory() else app.getCurrentFilesDirectory())
        val errorText = if (type == FileType.IMAGE) R.string.error_while_renaming_image else R.string.error_while_renaming_file
        val imported = ArrayList<FileAttachment>()
        val errors = ArrayList<FileError>()
        uris.forEachIndexed { index, uri ->
            val (attachment, error) = app.importFile(uri, directory, type, errorText)
            attachment?.let(imported::add)
            error?.let(errors::add)
            progress(index + 1, uris.size)
        }
        val saved = try {
            session.transaction { db ->
                val dao = db.getBaseNoteDao()
                val current = requireNotNull(dao.get(id))
                val updated = if (type == FileType.IMAGE) current.copy(images = current.images + imported) else current.copy(files = current.files + imported)
                dao.updateAll(listOf(updated))
                updated
            }
        } catch (error: Throwable) {
            // Only a SQL failure permits deleting unowned imported files.
            imported.forEach { java.io.File(directory, it.localName).delete() }
            throw error
        }
        effects.changed(listOf(saved))
        AttachmentImport(saved, errors)
    }

    suspend fun importRecording(id: Long): BaseNote = session.operation {
        requireNotNull(note(id)) { "Note $id no longer exists" }
        val original = app.getTempAudioFile()
        val audio = app.importAudio(original, false)
        val saved = update(longArrayOf(id)) { it.copy(audios = it.audios + audio) }.single()
        original.delete()
        saved
    }

    suspend fun removeAttachments(id: Long, attachments: Collection<Attachment>): BaseNote = session.operation {
        val updated = update(longArrayOf(id)) { note -> note.copy(
            images = note.images.filterNot { it in attachments },
            files = note.files.filterNot { it in attachments },
            audios = note.audios.filterNot { it in attachments },
        ) }.single()
        val remaining = allNotes().flatMap { it.images + it.files + it.audios }.map { it.storageKey() }.toSet()
        app.deleteAttachments(attachments.filterNot { it.storageKey() in remaining })
        updated
    }

    suspend fun editReminder(id: Long, reminder: Reminder, remove: Boolean = false, add: Boolean = false): BaseNote = session.operation {
        var savedReminder = reminder
        val updated = update(longArrayOf(id)) { note ->
            val reminders = note.reminders.toMutableList()
            if (remove) reminders.removeAll { it.id == reminder.id }
            else if (add) {
                savedReminder = reminder.copy(id = (reminders.maxOfOrNull { it.id } ?: -1) + 1)
                reminders.add(savedReminder)
            } else {
                val index = reminders.indexOfFirst { it.id == reminder.id }
                require(index >= 0) { "Reminder ${reminder.id} no longer exists" }
                reminders[index] = reminder
            }
            note.copy(reminders = reminders)
        }.single()
        if (!add) app.cancelReminder(id, reminder.id)
        if (!remove && updated.folder == Folder.NOTES) app.scheduleReminder(id, savedReminder)
        updated
    }

    data class AttachmentCleanup(val removed: Int, val affectedNotes: Int)

    suspend fun cleanupMissingAttachments(): AttachmentCleanup = session.operation {
        val result = session.transaction { db ->
            val dao = db.getBaseNoteDao()
            var removed = 0
            val changed = dao.getAll().mapNotNull { note ->
                val images = note.images.filter { app.resolveAttachmentFile(SUBFOLDER_IMAGES, it.localName)?.exists() == true }
                val files = note.files.filter { app.resolveAttachmentFile(SUBFOLDER_FILES, it.localName)?.exists() == true }
                val audios = note.audios.filter { app.resolveAttachmentFile(SUBFOLDER_AUDIOS, it.name)?.exists() == true }
                val missing = note.images.size + note.files.size + note.audios.size - images.size - files.size - audios.size
                if (missing == 0) null else {
                    removed += missing
                    note.copy(images = images, files = files, audios = audios)
                }
            }
            dao.updateAll(changed)
            AttachmentCleanup(removed, changed.size) to changed
        }
        effects.changed(result.second)
        result.first
    }

    suspend fun cleanupConvertedNotes() = session.transaction { db ->
        ConverterErrorReporter.enabled.set(false)
        try { db.getBaseNoteDao().updateAll(db.getBaseNoteDao().getAll()) }
        finally { ConverterErrorReporter.enabled.set(true) }
    }

    suspend fun checkBackupOnSave(note: BaseNote?, forceFullBackup: Boolean) = session.operation {
        val path = preferences.backupsFolder.value
        if (preferences.backupOnSave.value && path != NotallyXPreferences.EMPTY_PATH) {
            if (forceFullBackup) app.deleteModifiedNoteBackup(path)
            app.autoBackupOnSaveStored(path, preferences.backupPassword.value, note)
        }
    }

    suspend fun backupOnSave(path: String, password: String, note: BaseNote?) =
        session.operation { app.autoBackupOnSaveStored(path, password, note) }

    fun exportArchive(uri: Uri, compress: Boolean, password: String, progress: MutableLiveData<Progress>?, retry: Boolean) =
        session.read { app.exportAsZipStored(uri, compress, password, progress, retry) }

    fun exportDatabase(uri: Uri) = session.read { app.exportRawDatabaseStored(uri) }

    /** Crash recovery parses the entire replacement before deleting anything, then replaces in one Room transaction. */
    suspend fun replaceFromDatabase(uri: Uri, progress: MutableLiveData<Progress>?): ImportResult = session.operation {
        val staged = java.io.File.createTempFile("recovery-", ".sqlite", app.cacheDir)
        try {
            requireNotNull(app.contentResolver.openInputStream(uri)).use { input -> staged.outputStream().use { input.copyTo(it) } }
            val parsed = app.readBaseNotes(staged, progress)
            check(parsed.corruptedNotes == 0) { "Recovery source contains unreadable notes; original database was preserved" }
            val replaced = session.transaction { db ->
                val old = db.getBaseNoteDao().getAll()
                db.getBaseNoteDao().delete(old.map { it.id }.toLongArray())
                db.getLabelDao().deleteAll()
                val imported = db.getCommonDao().importBackup(parsed.baseNotes, parsed.originalIds, parsed.labels, 0, false)
                old to imported
            }
            effects.deleted(replaced.first, false, false)
            effects.moved(allNotes().filter { it.folder == Folder.NOTES }, Folder.NOTES)
            replaced.second
        } finally { staged.delete() }
    }

    suspend fun importDatabase(uri: Uri, duplicates: Boolean, progress: MutableLiveData<Progress>?) =
        session.operation { app.importRawDatabaseStored(uri, duplicates, progress) }

    suspend fun importArchive(uri: Uri, directory: java.io.File, password: String, duplicates: Boolean, progress: MutableLiveData<Progress>?) =
        session.operation { app.importZipStored(uri, directory, password, duplicates, progress) }

    suspend fun importExternal(uri: Uri, source: ImportSource, progress: MutableLiveData<Progress>?) =
        session.operation { NotesImporter(app.applicationContext as Application, this@NoteApplicationService).import(uri, source, progress) }

    companion object {
        @Volatile private var instance: NoteApplicationService? = null
        fun get(context: Context): NoteApplicationService = instance ?: synchronized(this) {
            instance ?: (context.applicationContext as ContextWrapper).let { app ->
                NoteApplicationService(app, DatabaseSession(app)).also { instance = it }
            }
        }
        internal fun resetForTest() = synchronized(this) { instance?.session?.close(); instance = null }
    }
}

/** Effects are replaceable in transaction tests; production always runs the Android implementation. */
internal interface NoteEffects {
    suspend fun saved(previous: BaseNote?, note: BaseNote, backup: Boolean)
    suspend fun changed(notes: List<BaseNote>)
    suspend fun moved(notes: List<BaseNote>, folder: Folder)
    suspend fun deleted(notes: List<BaseNote>, files: Boolean, backup: Boolean)
}

private class AndroidNoteEffects(private val app: ContextWrapper) : NoteEffects {
    override suspend fun saved(previous: BaseNote?, note: BaseNote, backup: Boolean) {
        changed(listOf(note))
        if (backup) app.checkBackupOnSave(NotallyXPreferences.getInstance(app), note,
            forceFullBackup = previous?.attachmentsDifferFrom(note) == true)
    }
    override suspend fun changed(notes: List<BaseNote>) {
        WidgetProvider.sendBroadcast(app, notes.map { it.id }.toLongArray())
        notes.forEach { note ->
            app.sendBroadcast(Intent(app, ReminderReceiver::class.java).apply {
                action = ReminderReceiver.ACTION_UPDATE_NOTIFICATIONS
                putExtra(ReminderReceiver.EXTRA_NOTE_ID, note.id)
            })
        }
    }
    override suspend fun moved(notes: List<BaseNote>, folder: Folder) {
        if (folder == Folder.NOTES) app.pinAndScheduleReminders(notes) else app.cancelPinAndReminders(notes)
        changed(notes)
    }
    override suspend fun deleted(notes: List<BaseNote>, files: Boolean, backup: Boolean) {
        app.cancelPinAndReminders(notes)
        WidgetProvider.sendBroadcast(app, notes.map { it.id }.toLongArray())
        if (files) withContext(Dispatchers.IO) { app.deleteAttachments(notes) }
        if (backup) app.checkBackupOnSave(NotallyXPreferences.getInstance(app), forceFullBackup = true)
    }
}
