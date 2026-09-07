package com.philkes.notallyx.presentation.viewmodel

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.print.PdfPrintListener
import android.view.View
import androidx.annotation.RequiresApi
import androidx.core.net.toUri
import androidx.documentfile.provider.DocumentFile
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.MediatorLiveData
import androidx.lifecycle.asFlow
import androidx.lifecycle.map
import androidx.lifecycle.viewModelScope
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.philkes.notallyx.R
import com.philkes.notallyx.application.NoteApplicationService
import com.philkes.notallyx.application.StorageMaintenance.Companion.DATABASE_NAME
import com.philkes.notallyx.data.dao.NoteReminder
import com.philkes.notallyx.data.imports.ImportException
import com.philkes.notallyx.data.imports.ImportSource
import com.philkes.notallyx.data.imports.NotesImporter
import com.philkes.notallyx.data.model.Attachment
import com.philkes.notallyx.data.model.Audio
import com.philkes.notallyx.data.model.BaseNote
import com.philkes.notallyx.data.model.Content
import com.philkes.notallyx.data.model.ConverterErrorReporter
import com.philkes.notallyx.data.model.Converters
import com.philkes.notallyx.data.model.FileAttachment
import com.philkes.notallyx.data.model.Folder
import com.philkes.notallyx.data.model.Header
import com.philkes.notallyx.data.model.Item
import com.philkes.notallyx.data.model.Label
import com.philkes.notallyx.data.model.SearchResult
import com.philkes.notallyx.data.model.deepCopy
import com.philkes.notallyx.presentation.activity.main.fragment.settings.SettingsFragment.Companion.EXTRA_SHOW_IMPORT_BACKUPS_FOLDER
import com.philkes.notallyx.presentation.activity.note.refreshStatusBarPin
import com.philkes.notallyx.presentation.exportedText
import com.philkes.notallyx.presentation.getQuantityString
import com.philkes.notallyx.presentation.restartApplication
import com.philkes.notallyx.presentation.setCancelButton
import com.philkes.notallyx.presentation.showSnackbar
import com.philkes.notallyx.presentation.showToast
import com.philkes.notallyx.presentation.view.misc.NotNullLiveData
import com.philkes.notallyx.presentation.view.misc.Progress
import com.philkes.notallyx.presentation.viewmodel.preference.BasePreference
import com.philkes.notallyx.presentation.viewmodel.preference.BiometricLock
import com.philkes.notallyx.presentation.viewmodel.preference.NotallyXPreferences
import com.philkes.notallyx.presentation.viewmodel.preference.NotallyXPreferences.Companion.EMPTY_PATH
import com.philkes.notallyx.presentation.viewmodel.preference.NotallyXPreferences.Companion.START_VIEW_DEFAULT
import com.philkes.notallyx.presentation.viewmodel.preference.NotallyXPreferences.Companion.START_VIEW_UNLABELED
import com.philkes.notallyx.presentation.viewmodel.preference.Theme
import com.philkes.notallyx.presentation.viewmodel.progress.ExportNotesProgress
import com.philkes.notallyx.utils.ActionMode
import com.philkes.notallyx.utils.Cache
import com.philkes.notallyx.utils.MIME_TYPE_JSON
import com.philkes.notallyx.utils.backup.copyDatabase
import com.philkes.notallyx.utils.backup.exportAsZip
import com.philkes.notallyx.utils.backup.exportPdfFile
import com.philkes.notallyx.utils.backup.exportPdfFileFolder
import com.philkes.notallyx.utils.backup.exportPlainTextFile
import com.philkes.notallyx.utils.backup.exportPlainTextFileFolder
import com.philkes.notallyx.utils.backup.importRawDatabase
import com.philkes.notallyx.utils.backup.importZip
import com.philkes.notallyx.utils.backup.readAsBackup
import com.philkes.notallyx.utils.cancelPinAndReminders
import com.philkes.notallyx.utils.copyToLarge
import com.philkes.notallyx.utils.deleteAttachments
import com.philkes.notallyx.utils.getBackupDir
import com.philkes.notallyx.utils.getCurrentImagesDirectory
import com.philkes.notallyx.utils.getExternalMediaDirectory
import com.philkes.notallyx.utils.log
import com.philkes.notallyx.utils.migrateAllAttachments
import com.philkes.notallyx.utils.security.DecryptionException
import com.philkes.notallyx.utils.security.EncryptionException
import com.philkes.notallyx.utils.security.decryptDatabase
import com.philkes.notallyx.utils.security.encryptDatabase
import com.philkes.notallyx.utils.security.isEncryptedDatabase
import com.philkes.notallyx.utils.security.isUnencryptedDatabase
import com.philkes.notallyx.utils.toMessage
import com.philkes.notallyx.utils.toReadablePath
import com.philkes.notallyx.utils.viewFile
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.Cipher
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class BaseNoteModel internal constructor(
    private val app: Application,
    private val notes: NoteApplicationService,
) : AndroidViewModel(app) {
    constructor(app: Application) : this(app, NoteApplicationService.get(app))

    private val labelCache = HashMap<String, Content>()

    lateinit var selectedExportMimeType: ExportMimeType

    var labels: LiveData<List<Label>> = NotNullLiveData(mutableListOf())
    var reminders: LiveData<List<NoteReminder>> = NotNullLiveData(mutableListOf())
    var baseNotes: Content? = Content(MutableLiveData(), ::transform)
    var deletedNotes: Content? = Content(MutableLiveData(), ::transform)
    var archivedNotes: Content? = Content(MutableLiveData(), ::transform)
    var reminderNotes: Content? = Content(MutableLiveData(), ::transform)

    val folder = NotNullLiveData(Folder.NOTES)

    var currentLabel: String? = CURRENT_LABEL_EMPTY

    var keyword = String()
        set(value) {
            if (field != value || searchResults?.value?.isEmpty() == true) {
                field = value
                searchResults!!.fetch(keyword, folder.value, currentLabel)
            }
        }

    var searchResults: SearchResult? = null

    private val pinned = Header(app.getString(R.string.pinned))
    private val others = Header(app.getString(R.string.others))
    private val archived = Header(app.getString(R.string.archived))

    val preferences = NotallyXPreferences.getInstance(app)

    val imageRoot
        get() = app.getCurrentImagesDirectory()

    val importProgress = MutableLiveData<Progress>()
    val progress = MutableLiveData<Progress>()

    val actionMode = ActionMode()

    internal var showRefreshBackupsFolderAfterThemeChange = false
    private var observing = false

    fun startObserving() {
        if (observing) return
        observing = true
        labels = notes.observeLabels()
        reminders = notes.observeReminders()
        val overview = MediatorLiveData<List<BaseNote>>()
        var rows = emptyList<BaseNote>()
        var hidden = preferences.labelsHidden.value
        fun publish() { overview.value = rows.filter { row -> row.labels.none { it in hidden } } }
        overview.addSource(notes.observeFolder(Folder.NOTES)) { rows = it; publish() }
        overview.addSource(preferences.labelsHidden.getData()) { hidden = it; publish() }
        baseNotes = Content(overview, ::transform)
        deletedNotes = Content(notes.observeFolder(Folder.DELETED), ::transform)
        archivedNotes = Content(notes.observeFolder(Folder.ARCHIVED), ::transform)
        reminderNotes = Content(notes.observeNotesWithReminders(), ::transform)
        searchResults = SearchResult(app, viewModelScope, notes, ::transform)
        viewModelScope.launch {
            folder.asFlow().collect { newFolder -> searchResults?.fetch(keyword, newFolder, currentLabel) }
        }
    }

    fun getNotesByLabel(label: String): Content {
        if (labelCache[label] == null) {
            labelCache[label] =
                Content(notes.observeLabel(label), ::transform, viewModelScope)
        }
        return requireNotNull(labelCache[label], { "labelCache has no '$label' value" })
    }

    fun getNotesWithoutLabel(): Content {
        return Content(
            notes.observeUnlabeled(Folder.NOTES),
            ::transform,
            viewModelScope,
        )
    }

    private fun transform(list: List<BaseNote>) = transform(list, pinned, others, archived)

    fun disableBackups() {
        val value = preferences.backupsFolder.value
        if (value != EMPTY_PATH) {
            clearPersistedUriPermissions(value)
        }
        savePreference(preferences.backupsFolder, EMPTY_PATH)
        savePreference(
            preferences.periodicBackups,
            preferences.periodicBackups.value.copy(periodInDays = 0),
        )
    }

    fun setupBackupsFolder(uri: Uri) {
        val oldBackupsFolder = preferences.backupsFolder.value
        val newBackupsFolder = uri.toString()
        if (newBackupsFolder != oldBackupsFolder) {
            val flags =
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            app.contentResolver.takePersistableUriPermission(uri, flags)
            if (oldBackupsFolder != EMPTY_PATH) {
                clearPersistedUriPermissions(oldBackupsFolder)
            }
            savePreference(preferences.backupsFolder, newBackupsFolder)
        }
        showRefreshBackupsFolderAfterThemeChange = false
    }

    fun enableDataInPublic(callback: (() -> Unit)? = null) {
        viewModelScope.launch { notes.maintenance.moveData(true); callback?.invoke() }
    }

    fun disableDataInPublic(callback: (() -> Unit)? = null) {
        viewModelScope.launch { notes.maintenance.moveData(false); callback?.invoke() }
    }

    suspend fun enableBiometricLock(cipher: Cipher) { notes.maintenance.enableLock(cipher) }

    @RequiresApi(Build.VERSION_CODES.M)
    suspend fun disableBiometricLock(cipher: Cipher? = null, callback: (() -> Unit)? = null) {
        notes.maintenance.disableLock(cipher)
        callback?.invoke()
    }

    fun <T> savePreference(preference: BasePreference<T>, value: T) {
        viewModelScope.launch(Dispatchers.IO) { preference.save(value) }
    }

    /**
     * Release previously persisted permissions, if any There is a hard limit of 128 before Android
     * 11, 512 after Check ->
     * https://commonsware.com/blog/2020/06/13/count-your-saf-uri-permission-grants.html
     */
    private fun clearPersistedUriPermissions(folderPath: String) {
        val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        app.contentResolver.persistedUriPermissions.forEach { permission ->
            val uriPath = permission.uri.path
            if (uriPath?.contains(folderPath) == true) {
                app.contentResolver.releasePersistableUriPermission(permission.uri, flags)
            }
        }
    }

    fun exportBackup(uri: Uri, onComplete: (() -> Unit)? = null) {
        viewModelScope.launch {
            val exportedNotesAndAttachments =
                withContext(Dispatchers.IO) {
                    app.log(TAG, msg = "Exporting backup to '$uri'...")
                    return@withContext app.exportAsZip(
                            uri,
                            password = preferences.backupPassword.value,
                            backupProgress = progress,
                        )
                        .also { app.log(TAG, msg = "Finished exporting backup to '$uri'") }
                }

            app.showToast(app.exportedText(exportedNotesAndAttachments))
            onComplete?.invoke()
        }
    }

    fun importRawDatabase(uri: Uri, checkDuplicates: Boolean) {
        val exceptionHandler = CoroutineExceptionHandler { _, throwable ->
            app.log(TAG, throwable = throwable)
            app.showToast("${app.getString(R.string.invalid_backup)}: ${throwable.message}")
        }

        viewModelScope.launch(exceptionHandler) {
            val importResult =
                withContext(Dispatchers.IO) {
                    app.importRawDatabase(uri, checkDuplicates, importProgress)
                }
            app.showToast(app.toMessage(importResult))
        }
    }

    fun importZipBackup(uri: Uri, password: String, checkDuplicates: Boolean) {
        val exceptionHandler = CoroutineExceptionHandler { _, throwable ->
            app.log(TAG, throwable = throwable)
            app.showToast("${app.getString(R.string.invalid_backup)}: ${throwable.message}")
        }

        val backupDir = app.getBackupDir()
        viewModelScope.launch(exceptionHandler) {
            app.importZip(uri, backupDir, password, checkDuplicates, importProgress)
        }
    }

    fun importXmlBackup(uri: Uri) {
        val exceptionHandler = CoroutineExceptionHandler { _, throwable ->
            app.log(TAG, throwable = throwable)
            app.showToast("${app.getString(R.string.invalid_backup)}: ${throwable.message}")
        }

        viewModelScope.launch(exceptionHandler) {
            val result =
                withContext(Dispatchers.IO) {
                    val stream =
                        requireNotNull(
                            app.contentResolver.openInputStream(uri),
                            { "InputStream for '$uri' is null" },
                        )
                    val (baseNotes, labels) = stream.readAsBackup()
                    notes.importNotes(baseNotes, labels, 0, false)
                }
            app.showToast(app.toMessage(result))
        }
    }

    fun importFromOtherApp(uri: Uri, importSource: ImportSource) {
        val exceptionHandler = CoroutineExceptionHandler { _, throwable ->
            app.log(TAG, throwable = throwable)
            if (throwable is ImportException) {
                app.showToast(throwable.textResId)
            } else {
                app.showToast("${app.getString(R.string.invalid_backup)}: ${throwable.message}")
            }
        }

        viewModelScope.launch(exceptionHandler) {
            val result =
                withContext(Dispatchers.IO) {
                    notes.importExternal(uri, importSource, importProgress)
                }
            app.showToast(app.toMessage(result))
        }
    }

    fun exportNoteToFile(fileUri: Uri, note: BaseNote, snackbarView: View) {
        val exceptionHandler = CoroutineExceptionHandler { _, throwable ->
            app.log(TAG, throwable = throwable)
            actionMode.close(true)
            app.showToast(R.string.something_went_wrong)
        }
        viewModelScope.launch(exceptionHandler) {
            when (selectedExportMimeType) {
                ExportMimeType.PDF -> {
                    exportPdfFile(
                        app,
                        note,
                        DocumentFile.fromSingleUri(app, fileUri)!!,
                        pdfPrintListener =
                            object : PdfPrintListener {
                                override fun onSuccess(file: DocumentFile) {
                                    actionMode.close(true)
                                    val message = app.getQuantityString(R.plurals.exported_notes, 1)
                                    snackbarView.showFileSnackbar(
                                        "$message to '${app.toReadablePath(fileUri)}'",
                                        fileUri,
                                        ExportMimeType.PDF,
                                    )
                                }

                                override fun onFailure(message: CharSequence?) {
                                    app.log(TAG, stackTrace = message as String?)
                                    actionMode.close(true)
                                }
                            },
                    )
                }
                else -> {
                    exportPlainTextFile(
                        app,
                        note,
                        DocumentFile.fromSingleUri(app, fileUri)!!,
                        selectedExportMimeType,
                    )
                    actionMode.close(true)
                    val message = app.getQuantityString(R.plurals.exported_notes, 1)
                    snackbarView.showFileSnackbar(
                        "$message to '${app.toReadablePath(fileUri)}'",
                        fileUri,
                        selectedExportMimeType,
                    )
                }
            }
        }
    }

    fun exportNotesToFolder(folderUri: Uri, notes: Collection<BaseNote>, snackbarView: View) {
        val exceptionHandler = CoroutineExceptionHandler { _, throwable ->
            app.log(TAG, throwable = throwable)
            actionMode.close(true)
            progress.postValue(ExportNotesProgress(inProgress = false))
            app.showToast(R.string.something_went_wrong)
        }
        viewModelScope.launch(exceptionHandler) {
            val counter = AtomicInteger(0)
            progress.postValue(ExportNotesProgress(total = notes.size))
            when (selectedExportMimeType) {
                ExportMimeType.PDF -> {
                    for (note in notes) {
                        exportPdfFileFolder(
                            app,
                            note,
                            DocumentFile.fromTreeUri(app, folderUri)!!,
                            progress = progress,
                            counter = counter,
                            total = notes.size,
                            pdfPrintListener =
                                object : PdfPrintListener {
                                    override fun onSuccess(file: DocumentFile) {
                                        actionMode.close(true)
                                        progress.postValue(ExportNotesProgress(inProgress = false))
                                        val message =
                                            app.getQuantityString(
                                                R.plurals.exported_notes,
                                                counter.get(),
                                            )
                                        snackbarView.showSnackbar(
                                            "$message to '${app.toReadablePath(folderUri)}'"
                                        )
                                    }

                                    override fun onFailure(message: CharSequence?) {
                                        app.log(TAG, stackTrace = message as String?)
                                        actionMode.close(true)
                                        progress.postValue(ExportNotesProgress(inProgress = false))
                                    }
                                },
                        )
                    }
                }
                else -> {
                    for (note in notes) {
                        exportPlainTextFileFolder(
                            app,
                            note,
                            selectedExportMimeType,
                            DocumentFile.fromTreeUri(app, folderUri)!!,
                            progress = progress,
                            counter = counter,
                            total = notes.size,
                        )
                    }
                    actionMode.close(true)
                    progress.postValue(ExportNotesProgress(inProgress = false))
                    val message = app.getQuantityString(R.plurals.exported_notes, counter.get())
                    snackbarView.showSnackbar("$message to '${app.toReadablePath(folderUri)}'")
                }
            }
        }
    }

    fun exportSelectedNotesToFolder(folderUri: Uri, snackbarView: View) {
        exportNotesToFolder(folderUri, actionMode.selectedNotes.values, snackbarView)
    }

    fun exportSelectedNoteToFile(fileUri: Uri, snackbarView: View) {
        exportNoteToFile(fileUri, actionMode.selectedNotes.values.first(), snackbarView)
    }

    private fun View.showFileSnackbar(msg: String, fileUri: Uri, mimeType: ExportMimeType) {
        showSnackbar(msg, R.string.open_link) { app.viewFile(fileUri, mimeType.mimeType) }
    }

    fun pinBaseNotes(pinned: Boolean) {
        val ids = actionMode.selectedIds.toLongArray()
        actionMode.close(true)
        viewModelScope.launch { notes.pin(ids, pinned) }
    }

    fun pinBaseNotesToStatusBar(activity: Activity, pinnedToStatusBar: Boolean) {
        val ids = actionMode.selectedIds.toLongArray()
        actionMode.close(true)
        viewModelScope.launch { notes.pinToStatus(ids, pinnedToStatusBar).forEach { activity.refreshStatusBarPin(it) } }
    }

    fun colorBaseNote(color: String) {
        val ids = actionMode.selectedIds.toLongArray()
        actionMode.close(true)
        viewModelScope.launch { notes.color(ids, color) }
    }

    fun changeColor(oldColor: String, newColor: String) {
        viewModelScope.launch { notes.changeColor(oldColor, newColor) }
    }

    fun moveBaseNotes(folder: Folder, callable: (() -> Unit)? = null): LongArray {
        val ids = actionMode.selectedIds.toLongArray()
        actionMode.close(false)
        moveBaseNotes(ids, folder, callable)
        return ids
    }

    fun moveBaseNotes(ids: LongArray, folder: Folder, callable: (() -> Unit)? = null) {
        viewModelScope.launch { notes.move(ids, folder); callable?.invoke() }
    }

    fun applyBaseNoteLabels(ids: LongArray, add: List<String>, remove: Set<String>) {
        val selectedIds = ids.copyOf()
        val addedLabels = add.toList()
        val removedLabels = remove.toSet()
        viewModelScope.launch {
            val result = notes.applyLabels(selectedIds, addedLabels, removedLabels)
            actionMode.close(true)
            if (result is NoteApplicationService.BatchLabelResult.StaleSelection) {
                app.showToast(R.string.label_selection_changed)
            }
        }
    }

    suspend fun deleteSelectedBaseNotes(): Collection<BaseNote> {
        val ids = actionMode.selectedIds.toLongArray()
        actionMode.close(false)
        return notes.delete(ids)
    }

    fun deleteAll() {
        viewModelScope.launch { notes.deleteAll(); app.showToast(R.string.cleared_data) }
    }

    fun deleteAllTrashedBaseNotes() {
        viewModelScope.launch { notes.emptyTrash() }
    }

    suspend fun duplicateNote(note: BaseNote) = notes.duplicate(listOf(note)).first()

    suspend fun duplicateNotes(notes: Collection<BaseNote>): List<Long> = this.notes.duplicate(notes)

    fun duplicateSelectedBaseNotes() {
        if (actionMode.isEmpty()) return
        val selected = actionMode.selectedNotes.values.toList()
        viewModelScope.launch {
            duplicateNotes(selected)
            actionMode.close(true)
            app.showToast(app.getQuantityString(R.plurals.duplicates, selected.size))
        }
    }

    suspend fun getAllLabels() = notes.labels()

    fun deleteLabel(value: String) {
        viewModelScope.launch { notes.deleteLabel(value) }
    }

    fun insertLabel(label: String, onComplete: (success: Boolean) -> Unit) =
        executeAsyncWithCallback({ notes.addLabel(label) }, onComplete)

    fun updateLabels(labels: List<Label>) {
        viewModelScope.launch { notes.reorderLabels(labels) }
    }

    fun updateLabel(oldValue: String, newValue: String, onComplete: (success: Boolean) -> Unit) {
        executeAsyncWithCallback({ notes.renameLabel(oldValue, newValue) }, onComplete)
    }

    suspend fun resetPreferences(callback: (restartRequired: Boolean) -> Unit) {
        val backupsFolder = preferences.backupsFolder.value
        val publicFolder = preferences.dataInPublicFolder.value
        val isThemeDefault = preferences.theme.value == Theme.FOLLOW_SYSTEM
        val finishCallback = { callback(!isThemeDefault) }
        if (preferences.isLockEnabled) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                disableBiometricLock {
                    finishResetPreferencesAfterBiometric(
                        publicFolder,
                        backupsFolder,
                        finishCallback,
                    )
                }
            } else finishResetPreferencesAfterBiometric(publicFolder, backupsFolder, finishCallback)
        } else finishResetPreferencesAfterBiometric(publicFolder, backupsFolder, finishCallback)
    }

    private fun finishResetPreferencesAfterBiometric(
        publicFolder: Boolean,
        backupsFolder: String,
        callback: (() -> Unit),
    ) {
        if (publicFolder) {
            refreshDataInPublicFolder(false) { finishResetPreferences(backupsFolder, callback) }
        } else finishResetPreferences(backupsFolder, callback)
    }

    private fun finishResetPreferences(backupsFolder: String, callback: () -> Unit) {
        preferences.reset()
        if (backupsFolder != EMPTY_PATH) {
            clearPersistedUriPermissions(backupsFolder)
        }
        callback()
        app.restartApplication(R.id.Settings)
    }

    fun importPreferences(
        context: Context,
        uri: Uri,
        askForUriPermissions: (uri: Uri) -> Unit,
        onSuccess: () -> Unit,
        onFailure: () -> Unit,
    ) {
        val oldBackupsFolder = preferences.backupsFolder.value
        val dataInPublicFolderBefore = preferences.dataInPublicFolder.value
        val themeBefore = preferences.theme.value
        val useDynamicColorsBefore = preferences.useDynamicColors.value
        val oldStartView = preferences.startView.value

        val success = preferences.import(context, uri)

        val dataInPublicFolder = preferences.dataInPublicFolder.getFreshValue()
        if (dataInPublicFolderBefore != dataInPublicFolder) {
            refreshDataInPublicFolder(dataInPublicFolder) {
                preferences.dataInPublicFolder.refresh()
                finishImportPreferences(
                    oldBackupsFolder,
                    themeBefore,
                    useDynamicColorsBefore,
                    oldStartView,
                    context,
                    askForUriPermissions,
                ) {
                    if (success) {
                        onSuccess()
                    } else onFailure()
                }
            }
        } else
            finishImportPreferences(
                oldBackupsFolder,
                themeBefore,
                useDynamicColorsBefore,
                oldStartView,
                context,
                askForUriPermissions,
            ) {
                if (success) {
                    onSuccess()
                } else onFailure()
            }
    }

    private fun finishImportPreferences(
        oldBackupsFolder: String,
        themeBefore: Theme,
        useDynamicColorsBefore: Boolean,
        oldStartView: String,
        context: Context,
        askForUriPermissions: (uri: Uri) -> Unit,
        callback: () -> Unit,
    ) {
        val backupFolder = preferences.backupsFolder.getFreshValue()
        val hasUseDynamicColorsChange =
            useDynamicColorsBefore != preferences.useDynamicColors.getFreshValue()
        if (oldBackupsFolder != backupFolder) {
            showRefreshBackupsFolderAfterThemeChange = true
            if (themeBefore == preferences.theme.getFreshValue() && !hasUseDynamicColorsChange) {
                refreshBackupsFolder(context, backupFolder, askForUriPermissions)
            }
        } else {
            showRefreshBackupsFolderAfterThemeChange = false
        }
        val startView = preferences.startView.getFreshValue()
        if (oldStartView != startView) {
            refreshStartView(startView, oldStartView)
        }
        preferences.theme.refresh()
        callback()
        if (showRefreshBackupsFolderAfterThemeChange) {
            app.restartApplication(R.id.Settings, EXTRA_SHOW_IMPORT_BACKUPS_FOLDER to true)
        }
    }

    fun refreshBackupsFolder(
        context: Context,
        backupFolder: String = preferences.backupsFolder.value,
        askForUriPermissions: (uri: Uri) -> Unit,
    ) {
        try {
            val backupFolderUri = backupFolder.toUri()
            MaterialAlertDialogBuilder(context)
                .setMessage(R.string.auto_backups_folder_rechoose)
                .setCancelButton { _, _ -> showRefreshBackupsFolderAfterThemeChange = false }
                .setOnDismissListener { showRefreshBackupsFolderAfterThemeChange = false }
                .setPositiveButton(R.string.choose_folder) { _, _ ->
                    askForUriPermissions(backupFolderUri)
                }
                .show()
        } catch (_: Exception) {
            showRefreshBackupsFolderAfterThemeChange = false
            disableBackups()
        }
    }

    private fun refreshDataInPublicFolder(dataInPublicFolder: Boolean, callback: () -> Unit) {
        if (dataInPublicFolder) {
            enableDataInPublic(callback)
        } else {
            disableDataInPublic(callback)
        }
    }

    private fun refreshStartView(startView: String, oldStartView: String) {
        if (startView in setOf(START_VIEW_DEFAULT, START_VIEW_UNLABELED)) {
            savePreference(preferences.startView, startView)
        } else {
            viewModelScope.launch {
                val startViewLabelExists =
                    withContext(Dispatchers.IO) { notes.labelExists(startView) }
                savePreference(
                    preferences.startView,
                    if (startViewLabelExists) startView else oldStartView,
                )
            }
        }
    }

    fun saveNotes(notes: List<BaseNote>) {
        viewModelScope.launch { this@BaseNoteModel.notes.saveAll(notes) }
    }

    fun cleanupDatabase(onComplete: () -> Unit) {
        viewModelScope.launch { notes.cleanupConvertedNotes(); onComplete() }
    }

    companion object {
        private const val TAG = "BaseNoteModel"

        const val CURRENT_LABEL_EMPTY = ""
        val CURRENT_LABEL_NONE: String? = null

        fun transform(
            list: List<BaseNote>,
            pinned: Header,
            others: Header,
            archived: Header,
        ): List<Item> {
            if (list.isEmpty()) {
                return list
            } else {
                val firstPinnedNote = list.indexOfFirst { baseNote -> baseNote.pinned }
                val firstUnpinnedNote =
                    list.indexOfFirst { baseNote ->
                        !baseNote.pinned && baseNote.folder != Folder.ARCHIVED
                    }
                val mutableList: MutableList<Item> = list.toMutableList()
                if (firstPinnedNote != -1) {
                    mutableList.add(firstPinnedNote, pinned)
                    if (firstUnpinnedNote != -1) {
                        mutableList.add(firstUnpinnedNote + 1, others)
                    }
                }
                val firstArchivedNote =
                    mutableList.indexOfFirst { item ->
                        item is BaseNote && item.folder == Folder.ARCHIVED
                    }
                if (firstArchivedNote != -1) {
                    mutableList.add(firstArchivedNote, archived)
                }
                return mutableList
            }
        }
    }
}

enum class ExportMimeType(val mimeType: String, val fileExtension: String) {
    TXT("text/plain", "txt"),
    MD("text/markdown", "md"),
    PDF("application/pdf", "pdf"),
    JSON(MIME_TYPE_JSON, "json"),
    HTML("text/html", "html"),
}
