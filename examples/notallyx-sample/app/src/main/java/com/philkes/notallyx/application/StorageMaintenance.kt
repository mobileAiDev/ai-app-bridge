package com.philkes.notallyx.application

import android.content.ContextWrapper
import android.database.sqlite.SQLiteBlobTooBigException
import android.net.Uri
import android.os.Build
import com.philkes.notallyx.data.NotallyDatabase
import com.philkes.notallyx.data.model.Type
import com.philkes.notallyx.data.dao.BaseNoteDao.Companion.MAX_BODY_CHAR_LENGTH
import com.philkes.notallyx.utils.NoteRepairUtils.truncateBodyAndFixSpans
import com.philkes.notallyx.utils.NoteSplitUtils.splitOversizedExistingNoteForMigration
import com.philkes.notallyx.utils.log
import com.philkes.notallyx.presentation.viewmodel.preference.BiometricLock
import com.philkes.notallyx.presentation.viewmodel.preference.NotallyXPreferences
import com.philkes.notallyx.utils.copyToLarge
import com.philkes.notallyx.utils.getExternalMediaDirectory
import com.philkes.notallyx.utils.getPrivateAttachmentsRoot
import com.philkes.notallyx.utils.getCurrentMediaRoot
import com.philkes.notallyx.utils.SUBFOLDER_IMAGES
import com.philkes.notallyx.utils.SUBFOLDER_FILES
import com.philkes.notallyx.utils.SUBFOLDER_AUDIOS
import com.philkes.notallyx.utils.migrateAllAttachments
import com.philkes.notallyx.utils.security.*
import java.io.File
import javax.crypto.Cipher

/** File metadata comes from the same drained database snapshot as the exported database file. */
data class DatabaseSnapshot(
    val noteCount: Int,
    val images: List<String>,
    val files: List<String>,
    val audios: List<String>,
)

class StorageMaintenance internal constructor(
    private val app: ContextWrapper,
    private val session: DatabaseSession,
    private val openCandidate: (Boolean) -> NotallyDatabase = { NotallyDatabase.getFreshDatabase(app, it) },
) {
    private val preferences get() = NotallyXPreferences.getInstance(app)

    fun copyDatabase(decrypt: Boolean = true, suffix: String = ""): Pair<DatabaseSnapshot, File> = session.read { database ->
        database.checkpoint()
        val dao = database.getBaseNoteDao()
        val snapshot = DatabaseSnapshot(dao.count(), dao.getAllImages(), dao.getAllFiles(), dao.getAllAudios())
        val source = NotallyDatabase.getCurrentDatabaseFile(app)
        val copy = File.createTempFile("$DATABASE_NAME$suffix-", ".sqlite", app.cacheDir)
        try {
            if (decrypt && preferences.isLockEnabled && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val cipher = getInitializedCipherForDecryption(iv = preferences.iv.value!!)
                val passphrase = cipher.doFinal(preferences.databaseEncryptionKey.value)
                decryptDatabase(app, passphrase, source, copy)
            } else source.copyToLarge(copy, overwrite = true)
            snapshot to copy
        } catch (error: Throwable) { copy.delete(); throw error }
    }

    suspend fun moveData(toPublic: Boolean): Unit = session.operation {
        if (preferences.dataInPublicFolder.value == toPublic) return@operation
        val previousPublic = preferences.dataInPublicFolder.value
        session.maintenance(rollback = { preferences.dataInPublicFolder.save(previousPublic) }) { database ->
            database.checkpoint()
            val source = NotallyDatabase.getCurrentDatabaseFile(app)
            val target = if (toPublic) NotallyDatabase.getExternalDatabaseFile(app) else NotallyDatabase.getInternalDatabaseFile(app)
            check(source.canonicalFile != target.canonicalFile) { "Source and destination storage are identical" }
            target.parentFile?.mkdirs()
            source.copyToLarge(target, overwrite = true)
            // The checkpointed main file is the snapshot. Stale WAL from an older target must not win.
            File(target.path + "-wal").delete()
            File(target.path + "-shm").delete()
            val candidate = openCandidate(toPublic)
            try { check(candidate.ping()) { "Copied database could not be opened" } }
            finally { candidate.close() }
            // Keep source DB/attachments intact until all copies and validation succeed.
            val sourceMedia = app.getCurrentMediaRoot()
            val targetMedia = if (toPublic) app.getExternalMediaDirectory() else app.getPrivateAttachmentsRoot()
            listOf(SUBFOLDER_IMAGES, SUBFOLDER_FILES, SUBFOLDER_AUDIOS).forEach { subfolder ->
                VerifiedFileCopy.copyTree(File(sourceMedia, subfolder), File(targetMedia, subfolder))
            }
            preferences.dataInPublicFolder.save(toPublic)
        }
    }

    suspend fun enableLock(cipher: Cipher): Unit = session.operation {
        if (preferences.isLockEnabled) return@operation
        val previousIv = preferences.iv.value
        val previousKey = preferences.databaseEncryptionKey.value
        try {
            preferences.iv.save(cipher.iv)
            val passphrase = preferences.databaseEncryptionKey.init(cipher)
            transformEncryption(true, passphrase)
        } catch (error: Throwable) {
            preferences.iv.save(previousIv)
            preferences.databaseEncryptionKey.save(previousKey)
            throw error
        }
    }

    suspend fun disableLock(cipher: Cipher? = null): Unit = session.operation {
        if (!preferences.isLockEnabled) return@operation
        val passphrase = cipher?.doFinal(preferences.databaseEncryptionKey.value)
            ?: requireNotNull(preferences.fallbackDatabaseEncryptionKey.value) { "No database decryption key" }
        transformEncryption(false, passphrase)
    }

    private suspend fun transformEncryption(encrypt: Boolean, passphrase: ByteArray) {
        val original = File.createTempFile("$DATABASE_NAME-original-", ".sqlite", app.cacheDir)
        val transformed = File.createTempFile("$DATABASE_NAME-transform-", ".sqlite", app.cacheDir)
        val previousLock = preferences.biometricLock.value
        val previousFallback = preferences.fallbackDatabaseEncryptionKey.value
        var source: File? = null
        var capturedOriginal = false
        try {
            session.maintenance(rollback = {
                if (capturedOriginal) original.copyToLarge(requireNotNull(source), overwrite = true)
                source?.let { File(it.path + "-wal").delete(); File(it.path + "-shm").delete() }
                preferences.fallbackDatabaseEncryptionKey.save(previousFallback)
                preferences.biometricLock.save(previousLock)
            }) { database ->
                database.checkpoint()
                database.close()
                source = NotallyDatabase.getCurrentDatabaseFile(app)
                source!!.copyToLarge(original, overwrite = true)
                capturedOriginal = true
                source!!.copyToLarge(transformed, overwrite = true)
                if (encrypt) encryptDatabase(app, transformed, passphrase) else decryptDatabase(app, transformed, passphrase)
                check(if (encrypt) transformed.isEncryptedDatabase else transformed.isUnencryptedDatabase) {
                    "Database encryption transformation failed validation"
                }
                transformed.copyToLarge(source!!, overwrite = true)
                File(source!!.path + "-wal").delete()
                File(source!!.path + "-shm").delete()
                if (encrypt) preferences.fallbackDatabaseEncryptionKey.save(passphrase)
                preferences.biometricLock.save(if (encrypt) BiometricLock.ENABLED else BiometricLock.DISABLED)
            }
        } finally { transformed.delete(); original.delete() }
    }

    suspend fun repairOversizedNotes() = session.transaction { db ->
    val dao = db.getBaseNoteDao()

    // ID-first to avoid loading huge rows into a single cursor; repair per-row if needed
    val ids = dao.getAllIds()
    var affected = 0
    var repaired = 0
    ids.forEach { id ->
        val original =
            try {
                dao.get(id)
            } catch (e: SQLiteBlobTooBigException) {
                // Repair the single offending row, then retry
                app.log(
                    TAG,
                    "Note (id: $id) threw SQLiteBlobTooBigException since body is too large to load. Repairing...",
                    e,
                )
                repaired += 1
                try {
                    truncateBodyAndFixSpans(dao, id)
                    dao.get(id)
                } catch (e: SQLiteBlobTooBigException) {
                    // The original row must survive a failed migration for recovery/export.
                    throw IllegalStateException("Note $id could not be repaired without data loss", e)
                }
            }
        if (original == null) return@forEach
        if (original.type != Type.NOTE) return@forEach
        val bodyLen = original.body.length
        if (bodyLen <= MAX_BODY_CHAR_LENGTH) return@forEach

        affected += 1
        val created = splitOversizedExistingNoteForMigration(original, dao)
        app.log(
            TAG,
            "Note (id: ${original.id}, title: '${original.title}') split into ${created+1} notes (was: $bodyLen characters).",
        )
    }

    app.log(TAG, "Migration 2 finished. Processed $affected oversized notes. Repaired rows: $repaired")    }

    companion object { private const val TAG = "StorageMaintenance"; const val DATABASE_NAME = "NotallyDatabase" }
}
