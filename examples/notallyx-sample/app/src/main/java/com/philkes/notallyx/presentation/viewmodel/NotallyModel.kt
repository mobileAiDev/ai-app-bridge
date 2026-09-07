package com.philkes.notallyx.presentation.viewmodel

import android.app.Application
import android.content.Intent
import android.graphics.Typeface
import android.net.Uri
import android.text.Editable
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.CharacterStyle
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.text.style.URLSpan
import androidx.core.text.getSpans
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.viewModelScope
import com.philkes.notallyx.R
import com.philkes.notallyx.application.NoteApplicationService
import com.philkes.notallyx.data.imports.txt.extractListItems
import com.philkes.notallyx.data.imports.txt.findListSyntaxRegex
import com.philkes.notallyx.data.model.Audio
import com.philkes.notallyx.data.model.BaseNote
import com.philkes.notallyx.data.model.FileAttachment
import com.philkes.notallyx.data.model.FileType
import com.philkes.notallyx.data.model.Folder
import com.philkes.notallyx.data.model.ListItem
import com.philkes.notallyx.data.model.NoteViewMode
import com.philkes.notallyx.data.model.Reminder
import com.philkes.notallyx.data.model.SpanRepresentation
import com.philkes.notallyx.data.model.Type
import com.philkes.notallyx.data.model.attachmentsDifferFrom
import com.philkes.notallyx.data.model.copy
import com.philkes.notallyx.data.model.deepCopy
import com.philkes.notallyx.presentation.activity.note.reminders.ReminderReceiver
import com.philkes.notallyx.presentation.activity.note.reminders.RemindersActivity.Companion.NEW_REMINDER_ID
import com.philkes.notallyx.presentation.applySpans
import com.philkes.notallyx.presentation.showToast
import com.philkes.notallyx.presentation.view.misc.NotNullLiveData
import com.philkes.notallyx.presentation.view.misc.Progress
import com.philkes.notallyx.presentation.viewmodel.preference.NotallyXPreferences
import com.philkes.notallyx.presentation.viewmodel.preference.TextSizeSp
import com.philkes.notallyx.presentation.viewmodel.progress.AddFilesProgress
import com.philkes.notallyx.presentation.widget.WidgetProvider
import com.philkes.notallyx.utils.Cache
import com.philkes.notallyx.utils.Event
import com.philkes.notallyx.utils.FileError
import com.philkes.notallyx.utils.backup.checkBackupOnSave
import com.philkes.notallyx.utils.backup.importAudio
import com.philkes.notallyx.utils.backup.importFile
import com.philkes.notallyx.utils.cancelPinAndReminders
import com.philkes.notallyx.utils.cancelReminder
import com.philkes.notallyx.utils.deleteAttachments
import com.philkes.notallyx.utils.getCurrentAudioDirectory
import com.philkes.notallyx.utils.getCurrentFilesDirectory
import com.philkes.notallyx.utils.getCurrentImagesDirectory
import com.philkes.notallyx.utils.getTempAudioFile
import com.philkes.notallyx.utils.scheduleReminder
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

typealias BackupFile = Pair<String?, File>

class NotallyModel(private val app: Application) : AndroidViewModel(app) {

    private val notes = NoteApplicationService.get(app)

    val preferences = NotallyXPreferences.getInstance(app)
    val textSize: TextSizeSp = preferences.textSizeNoteEditor.value

    var isNewNote = true

    var type = Type.NOTE

    var id = 0L
    var folder = Folder.NOTES
    var color = preferences.defaultNoteColor.value

    var title = String()
    var pinned = false
    var isPinnedToStatus = false
    var timestamp = System.currentTimeMillis()
    var modifiedTimestamp = System.currentTimeMillis()

    val labels = ArrayList<String>()

    var body: Editable = SpannableStringBuilder()

    val items = ArrayList<ListItem>()

    val images = NotNullLiveData<List<FileAttachment>>(emptyList())
    val files = NotNullLiveData<List<FileAttachment>>(emptyList())
    val audios = NotNullLiveData<List<Audio>>(emptyList())

    val reminders = NotNullLiveData<List<Reminder>>(emptyList())
    val viewMode = NotNullLiveData(NoteViewMode.EDIT)

    val addingFiles = MutableLiveData<Progress>()
    val eventBus = MutableLiveData<Event<List<FileError>>>()

    var imageRoot = app.getCurrentImagesDirectory()
    var audioRoot = app.getCurrentAudioDirectory()
    var filesRoot = app.getCurrentFilesDirectory()

    var originalNote: BaseNote? = null

    fun addAudio() { viewModelScope.launch { audios.value = notes.importRecording(id).audios } }

    fun deleteAudio(audio: Audio) { viewModelScope.launch {
        audios.value = notes.removeAttachments(id, listOf(audio)).audios
    } }

    fun addImages(uris: Array<Uri>) = addFiles(uris, FileType.IMAGE)
    fun addFiles(uris: Array<Uri>) = addFiles(uris, FileType.ANY)

    private fun addFiles(uris: Array<Uri>, fileType: FileType) {
        viewModelScope.launch {
            addingFiles.postValue(AddFilesProgress(0, uris.size))
            try {
                val result = notes.importAttachments(id, uris, fileType) { current, total ->
                    addingFiles.postValue(AddFilesProgress(current, total))
                }
                images.value = result.note.images
                files.value = result.note.files
                if (result.errors.isNotEmpty()) eventBus.value = Event(result.errors)
            } finally { addingFiles.postValue(AddFilesProgress(inProgress = false)) }
        }
    }

    fun deleteImages(list: ArrayList<FileAttachment>) { viewModelScope.launch {
        images.value = notes.removeAttachments(id, list).images
    } }

    fun deleteFiles(list: ArrayList<FileAttachment>) { viewModelScope.launch {
        files.value = notes.removeAttachments(id, list).files
    } }

    fun setLabels(list: List<String>) {
        labels.clear()
        labels.addAll(list)
    }

    suspend fun setState(id: Long, createInDb: Boolean = true) {
        if (id != 0L) {
            isNewNote = false

            val baseNote = withContext(Dispatchers.IO) { notes.note(id) }

            if (baseNote != null) {
                originalNote = baseNote.deepCopy()

                this.id = id
                folder = baseNote.folder
                color = baseNote.color

                title = baseNote.title
                pinned = baseNote.pinned
                timestamp = baseNote.timestamp
                modifiedTimestamp = baseNote.modifiedTimestamp

                setLabels(baseNote.labels)

                body = baseNote.body.applySpans(baseNote.spans)

                items.clear()
                items.addAll(baseNote.items)

                images.value = baseNote.images
                files.value = baseNote.files
                audios.value = baseNote.audios
                reminders.value = baseNote.reminders
                viewMode.value = baseNote.viewMode
                isPinnedToStatus = baseNote.isPinnedToStatus
            } else {
                originalNote = createBaseNote(createInDb)
                app.showToast(R.string.cant_find_note)
            }
        } else originalNote = createBaseNote(createInDb)
    }

    private suspend fun createBaseNote(createInDb: Boolean = true): BaseNote {
        val baseNote = getBaseNote()
        if (createInDb) {
            id = withContext(Dispatchers.IO) { notes.save(baseNote, backup = false) }
        }
        return baseNote.copy(id = id)
    }

    suspend fun deleteBaseNote(checkAutoSave: Boolean = true) {
        notes.delete(longArrayOf(id), deleteFiles = true, backup = checkAutoSave)
    }

    fun setItems(items: List<ListItem>) {
        this.items.clear()
        this.items.addAll(items)
    }

    suspend fun saveNote(checkBackupOnSave: Boolean = true): Long {
        val savedId = notes.save(getBaseNote(), backup = checkBackupOnSave)
        originalNote = withContext(Dispatchers.IO) { notes.note(savedId) }
        return savedId
    }

    suspend fun checkBackupOnSave(note: BaseNote = getBaseNote()) {
        app.checkBackupOnSave(
            preferences,
            note = note,
            forceFullBackup = originalNote?.attachmentsDifferFrom(note) == true,
        )
    }

    fun isEmpty(): Boolean {
        return title.isEmpty() &&
            body.isEmpty() &&
            items.none { item -> item.body.isNotEmpty() } &&
            files.value.isEmpty() &&
            images.value.isEmpty() &&
            audios.value.isEmpty()
    }

    fun isModified(): Boolean {
        return getBaseNote() != originalNote
    }

    private suspend fun updateImages() {
        withContext(Dispatchers.IO) { notes.setImages(id, images.value) }
    }

    private suspend fun updateFiles() {
        withContext(Dispatchers.IO) { notes.setFiles(id, files.value) }
    }

    private suspend fun updateAudios() {
        withContext(Dispatchers.IO) { notes.setAudios(id, audios.value) }
    }

    fun getBaseNote(): BaseNote {
        val spans = getFilteredSpans(body)
        val body = this.body.toString()
        val nonEmptyItems = this.items.filter { item -> item.body.isNotEmpty() }
        return BaseNote(
            id,
            type,
            folder,
            color,
            title,
            pinned,
            timestamp,
            modifiedTimestamp,
            labels,
            body,
            spans,
            nonEmptyItems,
            images.value,
            files.value,
            audios.value,
            reminders.value,
            viewMode.value,
            isPinnedToStatus,
        )
    }

    private fun getFilteredSpans(spanned: Spanned): ArrayList<SpanRepresentation> {
        val representations = LinkedHashSet<SpanRepresentation>()
        spanned.getSpans<CharacterStyle>().forEach { span ->
            val end = spanned.getSpanEnd(span)
            val start = spanned.getSpanStart(span)
            val representation =
                SpanRepresentation(start, end, false, false, null, false, false, false)

            when (span) {
                is StyleSpan -> {
                    representation.bold = span.style == Typeface.BOLD
                    representation.italic = span.style == Typeface.ITALIC
                }

                is URLSpan -> {
                    representation.link = true
                    representation.linkData = span.url
                }
                is TypefaceSpan -> representation.monospace = span.family == "monospace"
                is StrikethroughSpan -> representation.strikethrough = true
            }

            if (representation.isNotUseless()) {
                representations.add(representation)
            }
        }
        return getFilteredRepresentations(ArrayList(representations))
    }

    private fun getFilteredRepresentations(
        representations: ArrayList<SpanRepresentation>
    ): ArrayList<SpanRepresentation> {
        representations.forEachIndexed { index, representation ->
            val match =
                representations.find { spanRepresentation ->
                    spanRepresentation.isEqualInSize(representation)
                }
            if (match != null && representations.indexOf(match) != index) {
                if (match.bold) {
                    representation.bold = true
                }
                if (match.link) {
                    representation.link = true
                    representation.linkData = match.linkData
                }
                if (match.italic) {
                    representation.italic = true
                }
                if (match.monospace) {
                    representation.monospace = true
                }
                if (match.strikethrough) {
                    representation.strikethrough = true
                }
                val copy = ArrayList(representations)
                copy[index] = representation
                copy.remove(match)
                return getFilteredRepresentations(copy)
            }
        }
        return representations
    }

    suspend fun removeReminder(reminder: Reminder) {
        reminders.value = notes.editReminder(id, reminder, remove = true).reminders
    }

    suspend fun addReminder(reminder: Reminder) {
        reminders.value = notes.editReminder(id, reminder, add = true).reminders
    }

    suspend fun updateReminder(updatedReminder: Reminder) {
        reminders.value = notes.editReminder(id, updatedReminder).reminders
    }

    suspend fun convertTo(noteType: Type) {
        when (noteType) {
            Type.NOTE -> {
                body = SpannableStringBuilder(items.joinToString(separator = "\n") { it.body })
                type = Type.NOTE
                setItems(ArrayList())
            }
            Type.LIST -> {
                val text = body.toString()
                val listSyntaxRegex =
                    text.findListSyntaxRegex(checkContains = true, plainNewLineAllowed = true)
                if (listSyntaxRegex != null) {
                    setItems(text.extractListItems(listSyntaxRegex))
                } else {
                    setItems(
                        text.lines().mapIndexed { idx, itemText ->
                            ListItem(itemText, false, false, idx, mutableListOf())
                        }
                    )
                }
                type = Type.LIST
                body = SpannableStringBuilder()
            }
        }
        saveNote(checkBackupOnSave = false)
    }

    suspend fun refreshOriginalNote() {
        if (id == 0L) return
        val baseNote = withContext(Dispatchers.IO) { notes.note(id) }
        if (baseNote == null) return
        originalNote = baseNote.deepCopy()
        reminders.value = baseNote.reminders
    }


}
