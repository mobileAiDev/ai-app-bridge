package io.github.mobileaidev.aiappbridge.uia;

import org.json.JSONObject;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Executor;
import java.util.function.LongSupplier;

/** One runtime owns admission. HTTP lifetime never settles an admitted accessibility action. */
final class UiaActionEngine {
    interface Store { void save(String actionId, JSONObject record) throws Exception; }
    interface Callback { void completed(boolean handled, int interactionId); }
    interface Gateway {
        JSONObject validate(JSONObject request) throws Exception;
        boolean dispatch(JSONObject binding, int interactionId, Callback callback) throws Exception;
    }

    private static final class Entry {
        final String raw, hash, actionId;
        final JSONObject request;
        final long prepared, deadline;
        String phase = "prepared", receiptJson, receiptHash, storageError;
        boolean committed, scheduled, acknowledged;
        int interactionId;
        JSONObject binding;
        Entry(String raw, String hash, JSONObject request, long now) throws Exception {
            this.raw = raw; this.hash = hash; this.request = request;
            actionId = Wire.actionId(request); prepared = now;
            deadline = now + Wire.integer(request, "timeoutMs", 1, 60000);
        }
    }

    private final String bootId, epoch;
    private final int capacity;
    private final Store store;
    private final Gateway gateway;
    private final Executor worker;
    private final LongSupplier clock;
    private final Map<String, Entry> entries = new LinkedHashMap<>();
    private Entry active;
    private int nextInteraction = 1;
    private boolean closing;

    UiaActionEngine(String bootId, String epoch, int capacity, Store store, Gateway gateway,
            Executor worker, LongSupplier clock) {
        this.bootId = bootId; this.epoch = epoch; this.capacity = capacity;
        this.store = store; this.gateway = gateway; this.worker = worker; this.clock = clock;
    }

    private Entry locate(String raw, String hash, boolean create) throws Exception {
        JSONObject request = Wire.request(raw, hash, bootId, epoch);
        String actionId = Wire.string(request, "actionId");
        Entry entry = entries.get(actionId);
        if (entry != null) {
            if (!entry.raw.equals(raw) || !entry.hash.equals(hash)) throw new Wire.Failure("uia_action_identity_conflict");
            return entry;
        }
        if (!create) throw new Wire.Failure("uia_action_not_found");
        if (closing) throw new Wire.Failure("uia_runtime_closing");
        if (entries.size() >= capacity) throw new Wire.Failure("uia_action_capacity_exhausted");
        entry = new Entry(raw, hash, request, clock.getAsLong());
        entries.put(actionId, entry);
        return entry;
    }

    private JSONObject record(Entry entry) throws Exception {
        return new JSONObject().put("schemaVersion", Wire.RECORD).put("bootId", bootId).put("runtimeEpoch", epoch)
            .put("actionId", entry.actionId).put("requestJson", entry.raw).put("requestSha256", entry.hash)
            .put("preparedAtElapsedMs", entry.prepared).put("deadlineElapsedMs", entry.deadline)
            .put("phase", entry.phase).put("interactionId", entry.interactionId)
            .put("receiptJson", entry.receiptJson == null ? JSONObject.NULL : entry.receiptJson)
            .put("receiptSha256", entry.receiptHash == null ? JSONObject.NULL : entry.receiptHash)
            .put("acknowledged", entry.acknowledged);
    }

    private boolean commit(Entry entry) {
        try {
            store.save(entry.actionId, record(entry)); entry.committed = true; entry.storageError = null;
            if (entry.phase.equals("terminal") && active == entry) active = null;
            return true;
        } catch (Exception error) { entry.committed = false; entry.storageError = error.toString(); return false; }
    }

    private JSONObject view(Entry entry) throws Exception {
        if (!entry.committed) commit(entry);
        JSONObject result = new JSONObject().put("schemaVersion", Wire.EXECUTION).put("bootId", bootId)
            .put("runtimeEpoch", epoch).put("actionId", entry.actionId).put("requestSha256", entry.hash)
            .put("settled", entry.committed && entry.phase.equals("terminal")).put("phase", entry.phase)
            .put("acknowledged", entry.acknowledged && entry.committed);
        if (entry.committed && entry.phase.equals("terminal")) return result
            .put("receiptJson", entry.receiptJson).put("receiptSha256", entry.receiptHash);
        if (!entry.committed) result.put("storageError", entry.storageError);
        return result.put("ok", false).put("dispatched", JSONObject.NULL).put("ambiguous", true)
            .put("error", !entry.committed ? "uia_journal_write_failed" : "uia_action_pending");
    }

    private void terminal(Entry entry, boolean ok, boolean dispatched, String error, String completion) throws Exception {
        JSONObject receipt = new JSONObject().put("schemaVersion", Wire.EXECUTION).put("bootId", bootId)
            .put("runtimeEpoch", epoch).put("actionId", entry.actionId).put("requestSha256", entry.hash)
            .put("settled", true).put("ok", ok).put("dispatched", dispatched).put("ambiguous", false)
            .put("completion", completion).put("completedAtElapsedMs", clock.getAsLong());
        if (error != null) receipt.put("error", error);
        if (entry.binding != null) receipt.put("binding", entry.binding);
        if (completion.equals("original_callback")) receipt.put("callback", new JSONObject()
            .put("interactionId", entry.interactionId).put("handled", ok));
        entry.receiptJson = receipt.toString(); entry.receiptHash = Wire.sha256(entry.receiptJson);
        entry.phase = "terminal"; entry.committed = false; commit(entry);
    }

    private void expire(Entry entry) throws Exception {
        if ((entry.phase.equals("prepared") || entry.phase.equals("queued")) && clock.getAsLong() >= entry.deadline)
            terminal(entry, false, false, "deadline_exceeded", "before_admission");
    }

    synchronized JSONObject prepare(String raw, String hash) throws Exception {
        Entry entry = locate(raw, hash, true); expire(entry); return view(entry);
    }

    synchronized JSONObject start(String raw, String hash) throws Exception {
        Entry entry = locate(raw, hash, false); expire(entry);
        if (closing) throw new Wire.Failure("uia_runtime_closing");
        if (!entry.committed && !commit(entry)) return view(entry);
        if (entry.phase.equals("prepared")) {
            if (active != null && active != entry) return view(entry).put("error", "uia_runtime_busy");
            active = entry; entry.phase = "queued"; entry.committed = false;
            if (!commit(entry)) return view(entry);
        }
        if (entry.phase.equals("queued") && !entry.scheduled) {
            entry.scheduled = true;
            try { worker.execute(() -> execute(entry)); }
            catch (RuntimeException error) { terminal(entry, false, false, "uia_worker_unavailable", "before_admission"); }
        }
        return view(entry);
    }

    private void execute(Entry entry) {
        try {
            synchronized (this) { expire(entry); if (!entry.phase.equals("queued")) return; }
            JSONObject binding = gateway.validate(entry.request);
            synchronized (this) {
                expire(entry); if (!entry.phase.equals("queued")) return;
                entry.binding = binding; entry.interactionId = nextInteraction++;
                entry.phase = "admitted"; entry.committed = false;
                if (!commit(entry)) {
                    terminal(entry, false, false, "uia_journal_write_failed", "before_admission"); return;
                }
            }
            boolean admitted;
            try { admitted = gateway.dispatch(binding, entry.interactionId, (handled, id) -> completed(entry, handled, id)); }
            catch (Exception error) {
                synchronized (this) {
                    // Binder may have accepted work before its transport failed. Only the original callback settles it.
                    if (!entry.phase.equals("terminal")) { entry.phase = "unknown"; entry.committed = false; commit(entry); }
                }
                return;
            }
            synchronized (this) {
                if (!admitted && !entry.phase.equals("terminal"))
                    terminal(entry, false, false, "uia_action_not_admitted", "admission_rejected");
            }
        } catch (Exception error) {
            synchronized (this) {
                try { if (entry.phase.equals("queued")) terminal(entry, false, false, Wire.code(error), "before_admission"); }
                catch (Exception fatal) { throw new IllegalStateException(fatal); }
            }
        }
    }

    private synchronized void completed(Entry entry, boolean handled, int interactionId) {
        if (entry.interactionId != interactionId || (!entry.phase.equals("admitted") && !entry.phase.equals("unknown"))) return;
        try { terminal(entry, handled, true, handled ? null : "uia_action_not_handled", "original_callback"); }
        catch (Exception error) { throw new IllegalStateException(error); }
    }

    synchronized JSONObject query(String raw, String hash) throws Exception {
        Entry entry = locate(raw, hash, false); expire(entry); return view(entry);
    }

    synchronized JSONObject cancel(String raw, String hash) throws Exception {
        // An absent action gets a durable tombstone: delayed prepare/start cannot execute it later.
        Entry entry = locate(raw, hash, true);
        if (entry.phase.equals("prepared") || entry.phase.equals("queued"))
            terminal(entry, false, false, "cancelled", "before_admission");
        return view(entry);
    }

    synchronized JSONObject acknowledge(String raw, String hash, String receiptHash) throws Exception {
        Entry entry = locate(raw, hash, false);
        if (!entry.phase.equals("terminal") || !entry.committed || !entry.receiptHash.equals(receiptHash))
            throw new Wire.Failure("uia_completion_identity_mismatch");
        entry.acknowledged = true; entry.committed = false; return view(entry);
    }

    synchronized JSONObject status() throws Exception {
        int pending = 0, acknowledged = 0;
        for (Entry entry : entries.values()) {
            expire(entry); if (!entry.committed) commit(entry);
            if (!entry.phase.equals("terminal") || !entry.committed) pending++;
            if (entry.acknowledged && entry.committed) acknowledged++;
        }
        return new JSONObject().put("ok", true).put("schemaVersion", Wire.EXECUTION).put("bootId", bootId)
            .put("runtimeEpoch", epoch).put("count", entries.size()).put("capacity", capacity)
            .put("pending", pending).put("acknowledged", acknowledged).put("closing", closing)
            .put("activeActionId", active == null ? JSONObject.NULL : active.actionId);
    }

    synchronized boolean beginClose() throws Exception {
        if (status().getInt("pending") != 0) return false;
        closing = true; return true;
    }
}
