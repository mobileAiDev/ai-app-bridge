package com.philkes.notallyx.application

import java.nio.file.Files
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test

class StorageOperationGateTest {
    @Test fun independentCommandsSerializeUntilPostCommitEffectsFinish() = runBlocking {
        val gate = StorageOperationGate()
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val secondEntered = CompletableDeferred<Unit>()
        val first = launch(Dispatchers.Default) { gate.operation { entered.complete(Unit); release.await() } }
        entered.await()
        val second = launch(Dispatchers.Default) { gate.operation { secondEntered.complete(Unit) } }
        delay(80)
        assertFalse(secondEntered.isCompleted)
        release.complete(Unit)
        withTimeout(3000) { first.join(); second.join() }
        assertTrue(secondEntered.isCompleted)
    }

    @Test fun cancelledWaiterDoesNotNeedTheCurrentOwnerToRelease() = runBlocking {
        val gate = StorageOperationGate()
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val holder = launch { gate.operation { entered.complete(Unit); release.await() } }
        entered.await()
        val waiter = launch { gate.operation { fail("Cancelled command ran") } }
        delay(40)
        withTimeout(1000) { waiter.cancelAndJoin() }
        release.complete(Unit)
        holder.join()
        assertEquals(7, gate.operation { 7 })
    }

    @Test fun serialNestedWorkAcrossDispatcherAndExceptionReleasesOwnership() = runBlocking {
        val gate = StorageOperationGate()
        try {
            gate.operation { withContext(Dispatchers.Default) { gate.operation { assertEquals(4, gate.read { 4 }); error("expected") } } }
            fail("Exception expected")
        } catch (expected: IllegalStateException) { assertEquals("expected", expected.message) }
        assertEquals(8, withTimeout(1000) { gate.operation { 8 } })
    }

    @Test fun parallelNestedCommandsFailInsteadOfSilentlyRacing() = runBlocking {
        val gate = StorageOperationGate()
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        gate.operation {
            supervisorScope {
                val first = async { gate.operation { entered.complete(Unit); release.await() } }
                entered.await()
                val second = async { gate.operation { error("Parallel command entered") } }
                try { second.await(); fail("Parallel nesting must fail") }
                catch (expected: IllegalStateException) { assertTrue(expected.message!!.contains("Parallel nested")) }
                release.complete(Unit)
                first.await()
            }
        }
    }

    @Test fun failedSecondAttachmentCopyKeepsEverySourceAndRejectsCorruption() {
        val root = Files.createTempDirectory("attachment-migration").toFile()
        try {
            val source = root.resolve("source").apply { mkdirs() }
            source.resolve("first").writeText("first-original")
            source.resolve("second").writeText("second-original")
            var count = 0
            try {
                VerifiedFileCopy.copyTree(source, root.resolve("target")) { from, to ->
                    if (++count == 2) throw IOException("disk full")
                    from.copyTo(to)
                }
                fail("Migration must fail")
            } catch (expected: IOException) { assertEquals("disk full", expected.message) }
            assertEquals("first-original", source.resolve("first").readText())
            assertEquals("second-original", source.resolve("second").readText())
            try {
                VerifiedFileCopy.copyTree(source, root.resolve("corrupt")) { _, to -> to.writeText("truncated") }
                fail("Corruption must fail verification")
            } catch (expected: IllegalStateException) { assertTrue(expected.message!!.contains("verification")) }
        } finally { root.deleteRecursively() }
    }
}
