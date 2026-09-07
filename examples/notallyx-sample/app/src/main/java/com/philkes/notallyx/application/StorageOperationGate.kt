package com.philkes.notallyx.application

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.ThreadContextElement
import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.withContext

/** Serial operations may nest across dispatchers. Parallel children must acquire their own operation. */
internal class StorageOperationGate {
    private class Owner(var leaf: Job?)
    private val permit = Semaphore(1)
    private data class Active(val token: Owner, val job: Job?)
    private val owner = ThreadLocal<Active?>()
    private val ownerKey = object : CoroutineContext.Key<OwnerElement> {}
    private inner class OwnerElement(private val token: Owner) : ThreadContextElement<Active?>, AbstractCoroutineContextElement(ownerKey) {
        override fun updateThreadContext(context: CoroutineContext): Active? = owner.get().also { owner.set(Active(token, context[Job])) }
        override fun restoreThreadContext(context: CoroutineContext, oldState: Active?) { owner.set(oldState) }
    }
    @Volatile private var activeOwner: Owner? = null
    private fun currentOwner() = owner.get()?.takeIf { it.token === activeOwner }
    private fun Owner.checkCaller(job: Job?) {
        check(leaf == null || job === leaf || leaf!!.contains(job)) {
            "Parallel nested storage operations are unsupported; invoke independent application commands"
        }
    }

    fun <T> read(block: () -> T): T {
        currentOwner()?.let { active -> return synchronized(active.token) { active.token.checkCaller(active.job); block() } }
        runBlocking { permit.acquire() }
        val previous = owner.get()
        val token = Owner(null)
        activeOwner = token
        owner.set(Active(token, null))
        return try { block() } finally {
            owner.set(previous)
            activeOwner = null
            permit.release()
        }
    }

    suspend fun <T> operation(block: suspend () -> T): T {
        currentOwner()?.let { active ->
            val token = active.token
            val job = currentCoroutineContext()[Job]
            val previous = synchronized(token) {
                token.checkCaller(job)
                token.leaf.also { token.leaf = job }
            }
            return try { block() } finally { synchronized(token) { token.leaf = previous } }
        }
        return withContext(Dispatchers.IO) {
            permit.acquire()
            val token = Owner(null)
            activeOwner = token
            try {
                withContext(OwnerElement(token)) {
                    token.leaf = currentCoroutineContext()[Job]
                    block()
                }
            } finally { activeOwner = null; permit.release() }
        }
    }

    private fun Job.contains(other: Job?): Boolean = children.any { it === other || it.contains(other) }
}
