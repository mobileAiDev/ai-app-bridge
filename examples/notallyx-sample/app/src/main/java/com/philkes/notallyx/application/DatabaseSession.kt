package com.philkes.notallyx.application

import android.content.ContextWrapper
import android.os.Looper
import kotlinx.coroutines.NonCancellable
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.asFlow
import androidx.lifecycle.switchMap
import androidx.room.withTransaction
import com.philkes.notallyx.data.NotallyDatabase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.withContext

/** Owns the Room handle. A database/DAO never escapes an application operation or query factory. */
internal class DatabaseSession(
    private val context: ContextWrapper,
    private val open: () -> NotallyDatabase = { NotallyDatabase.getDatabase(context, false).value },
    private val reset: () -> Unit = { NotallyDatabase.clearInstance(context) },
) {
    private val gate = StorageOperationGate()
    @Volatile private var current: NotallyDatabase? = open()
    private val databases = MutableLiveData<NotallyDatabase?>(current)

    private fun database(): NotallyDatabase = checkNotNull(current) { "Storage is unavailable after maintenance" }

    fun <T> read(block: (NotallyDatabase) -> T): T {
        check(Looper.myLooper() != Looper.getMainLooper()) { "Synchronous storage reads must run off the main thread" }
        return gate.read { block(database()) }
    }

    suspend fun <T> operation(block: suspend () -> T): T = gate.operation(block)

    suspend fun <T> transaction(block: suspend (NotallyDatabase) -> T): T = gate.operation {
        val db = database()
        db.withTransaction { block(db) }
    }

    fun <T> observe(query: (NotallyDatabase) -> LiveData<T>): LiveData<T> {
        return databases.switchMap { db -> if (db == null) MutableLiveData<T>() else query(db) }
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    fun <T> observeFlow(query: (NotallyDatabase) -> Flow<T>): Flow<T> {
        return databases.asFlow().flatMapLatest { db -> if (db == null) flowOf() else query(db) }
    }

    /** Owns the close/reopen transition; recovery cannot be interrupted by caller cancellation. */
    suspend fun <T> maintenance(rollback: () -> Unit = {}, block: (NotallyDatabase) -> T): T = gate.operation {
        val old = database()
        withContext(Dispatchers.Main.immediate) { databases.value = null }
        withContext(NonCancellable) {
            try {
                val result = block(old)
                old.close()
                current = null
                replaceHandle()
                result
            } catch (failure: Throwable) {
                current?.close()
                current = null
                try {
                    rollback()
                    replaceHandle()
                } catch (recovery: Throwable) { failure.addSuppressed(recovery) }
                throw failure
            }
        }
    }

    private fun replaceHandle() {
        reset()
        val replacement = open()
        try { check(replacement.ping()) { "Reopened database failed its read probe" } }
        catch (error: Throwable) { replacement.close(); throw error }
        current = replacement
        databases.postValue(replacement)
    }

    internal fun close() = gate.read {
        current?.close()
        current = null
        reset()
        databases.postValue(null)
    }
}
