package com.philkes.notallyx.utils

import android.app.Application
import android.content.ContextWrapper
import android.database.sqlite.SQLiteBlobTooBigException
import com.philkes.notallyx.data.dao.BaseNoteDao.Companion.MAX_BODY_CHAR_LENGTH
import com.philkes.notallyx.data.model.Type
import com.philkes.notallyx.presentation.viewmodel.preference.NotallyXPreferences
import com.philkes.notallyx.utils.NoteRepairUtils.truncateBodyAndFixSpans
import com.philkes.notallyx.utils.NoteSplitUtils.splitOversizedExistingNoteForMigration
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private const val TAG = "DataSchemaMigrations"

const val LATEST_DATA_SCHEMA = 2

/**
 * Runs pending data schema migrations synchronously and reports progress via [onProgressTitle].
 * Returns true if any migration work was executed.
 */
suspend fun Application.runMigrations(onProgressTitle: (Int) -> Unit = {}): Boolean {
    val preferences = NotallyXPreferences.getInstance(this)
    val dataSchemaId = preferences.dataSchemaId.value
    var newDataSchemaId = dataSchemaId
    var didWork = false

    withContext(Dispatchers.IO) {
        if (dataSchemaId < 1) {
            onProgressTitle(com.philkes.notallyx.R.string.migration_moving_attachments)
            moveAttachments(preferences)
            newDataSchemaId = 1
            didWork = true
        }
        if (newDataSchemaId < 2) {
            onProgressTitle(com.philkes.notallyx.R.string.migration_splitting_notes)
            splitOversizedNotes()
            newDataSchemaId = 2
            didWork = true
        }
        if (didWork) {
            preferences.setDataSchemaId(newDataSchemaId)
        }
    }
    return didWork
}

private fun Application.moveAttachments(preferences: NotallyXPreferences) {
    val toPrivate = !preferences.dataInPublicFolder.value
    log(
        TAG,
        "Running migration 1: Moving attachments to ${if(toPrivate) "private" else "public"} folder",
    )
    migrateAllAttachments(toPrivate)
}

/**
 * Migration 2 Split existing notes whose body exceeds the newly introduced MAX_BODY_SIZE_MB limit.
 * If a note is too long, create additional notes with the remaining text and append a link at the
 * end of each truncated note that points to the next note. The link text is included in the body
 * and must also fit within the size limit.
 */
suspend fun Application.splitOversizedNotes() {
    log(
        TAG,
        "Running migration 2: Splitting notes exceeding the body size limit (limit: $MAX_BODY_CHAR_LENGTH characters)",
    )

    com.philkes.notallyx.application.NoteApplicationService.get(this).maintenance.repairOversizedNotes()
}
