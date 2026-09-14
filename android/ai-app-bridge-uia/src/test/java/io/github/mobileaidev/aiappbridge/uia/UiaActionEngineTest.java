package io.github.mobileaidev.aiappbridge.uia;

import org.json.JSONObject;
import org.junit.Test;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Map;
import java.util.Queue;
import java.util.UUID;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicLong;
import static org.junit.Assert.*;

public class UiaActionEngineTest {
    private static final String BOOT = UUID.randomUUID().toString(), EPOCH = UUID.randomUUID().toString();

    private static final class Worker implements Executor {
        final Queue<Runnable> jobs = new ArrayDeque<>();
        @Override public void execute(Runnable job) { jobs.add(job); }
        void run() { jobs.remove().run(); }
    }

    private static final class Gateway implements UiaActionEngine.Gateway {
        int dispatches, interaction;
        boolean admit = true, throwAfterDispatch;
        UiaActionEngine.Callback callback;
        Runnable duringValidation;
        String validationError;
        @Override public JSONObject validate(JSONObject request) throws Exception {
            if (duringValidation != null) duringValidation.run();
            if (validationError != null) throw new Wire.Failure(validationError);
            return new JSONObject().put("sourceId", "-4294967288");
        }
        @Override public boolean dispatch(JSONObject binding, int id, UiaActionEngine.Callback callback) throws Exception {
            dispatches++; interaction = id; this.callback = callback;
            if (throwAfterDispatch) throw new java.io.IOException("response lost");
            return admit;
        }
        void complete(boolean handled) { callback.completed(handled, interaction); }
    }

    private static final class Fixture {
        final AtomicLong clock = new AtomicLong(100);
        final Worker worker = new Worker();
        final Gateway gateway = new Gateway();
        final Map<String, JSONObject> disk = new HashMap<>();
        final UiaActionEngine engine;
        String failingPhase;
        Fixture() { this(256); }
        Fixture(int capacity) {
            engine = new UiaActionEngine(BOOT, EPOCH, capacity, (id, record) -> {
                if (record.getString("phase").equals(failingPhase)) throw new java.io.IOException("fsync failed");
                disk.put(id, new JSONObject(record.toString()));
            }, gateway, worker, clock::get);
        }
        JSONObject call(String operation, JSONObject request) throws Exception {
            String raw = request.toString(), hash = Wire.sha256(raw);
            switch (operation) {
                case "prepare": return engine.prepare(raw, hash);
                case "start": return engine.start(raw, hash);
                case "query": return engine.query(raw, hash);
                case "cancel": return engine.cancel(raw, hash);
                default: throw new AssertionError(operation);
            }
        }
        void start(JSONObject request) throws Exception { call("prepare", request); call("start", request); worker.run(); }
        JSONObject receipt(JSONObject request) throws Exception {
            JSONObject result = call("query", request);
            assertTrue(result.getBoolean("settled"));
            assertEquals(result.getString("receiptSha256"), Wire.sha256(result.getString("receiptJson")));
            return new JSONObject(result.getString("receiptJson"));
        }
    }

    private static JSONObject request() throws Exception {
        return new JSONObject().put("schemaVersion", Wire.EXECUTION).put("bootId", BOOT).put("runtimeEpoch", EPOCH)
            .put("actionId", UUID.randomUUID().toString()).put("timeoutMs", 1000).put("clickPolicy", "nearest_clickable_ancestor")
            .put("target", new JSONObject().put("snapshotId", UUID.randomUUID().toString()).put("ref", UUID.randomUUID().toString())
                .put("selector", new JSONObject().put("kind", "text").put("value", "Increment").put("exact", true).put("packageName", JSONObject.NULL)));
    }

    @Test public void prepareAndRepeatedStartDispatchOnlyOnceAndKeepOriginalReceipt() throws Exception {
        Fixture f = new Fixture(); JSONObject request = request();
        f.call("prepare", request); f.call("prepare", request);
        assertEquals(0, f.gateway.dispatches);
        f.call("start", request); f.call("start", request);
        assertEquals(1, f.worker.jobs.size()); f.worker.run();
        assertFalse(f.call("query", request).getBoolean("settled"));
        f.gateway.complete(true);
        JSONObject first = f.call("query", request);
        f.call("start", request); f.gateway.complete(false);
        assertEquals(first.toString(), f.call("query", request).toString());
        assertEquals(1, f.gateway.dispatches);
        JSONObject receipt = f.receipt(request);
        assertTrue(receipt.getBoolean("ok")); assertTrue(receipt.getBoolean("dispatched"));
        assertEquals("original_callback", receipt.getString("completion"));
        assertEquals(first.getString("receiptJson"), f.disk.get(request.getString("actionId")).getString("receiptJson"));
    }

    @Test public void referenceSelectorRequiresTheExactObservedReferenceAndPackage() throws Exception {
        JSONObject request = request(), target = request.getJSONObject("target"), selector = target.getJSONObject("selector");
        selector.put("kind", "nodeRef").put("value", target.getString("ref")).put("packageName", "example.uia");
        Fixture f = new Fixture(); f.start(request); f.gateway.complete(true);
        assertTrue(f.receipt(request).getBoolean("ok"));
        for (int change = 0; change < 3; change++) {
            JSONObject invalid = new JSONObject(request.toString()), changed = invalid.getJSONObject("target").getJSONObject("selector");
            if (change == 0) changed.put("value", UUID.randomUUID().toString());
            if (change == 1) changed.put("exact", false);
            if (change == 2) changed.put("packageName", JSONObject.NULL);
            try {
                Wire.request(invalid.toString(), Wire.sha256(invalid.toString()), BOOT, EPOCH);
                fail("An invalid node-reference selector must not be admitted");
            } catch (Wire.Failure expected) {
                assertEquals("invalid_node_reference_selector", expected.getMessage());
            }
        }
    }

    @Test public void callbackFalseIsCompletedExecutionNotMissingCallback() throws Exception {
        Fixture f = new Fixture(); JSONObject request = request(); f.start(request); f.gateway.complete(false);
        JSONObject receipt = f.receipt(request);
        assertEquals("uia_action_not_handled", receipt.getString("error")); assertTrue(receipt.getBoolean("dispatched"));
        assertFalse(receipt.getJSONObject("callback").getBoolean("handled"));
    }

    @Test public void platformAdmissionFalseDoesNotClaimDispatch() throws Exception {
        Fixture f = new Fixture(); f.gateway.admit = false; JSONObject request = request(); f.start(request);
        JSONObject receipt = f.receipt(request);
        assertFalse(receipt.getBoolean("dispatched")); assertEquals("admission_rejected", receipt.getString("completion"));
        assertFalse(receipt.has("callback"));
    }

    @Test public void timeoutAndCancelAfterAdmissionWaitForOriginalCallback() throws Exception {
        Fixture f = new Fixture(); JSONObject request = request(); f.start(request); f.clock.set(999999);
        assertFalse(f.call("cancel", request).getBoolean("settled"));
        assertFalse(f.call("query", request).getBoolean("settled"));
        assertFalse(f.engine.beginClose());
        f.gateway.complete(true); assertTrue(f.receipt(request).getBoolean("ok")); assertTrue(f.engine.beginClose());
    }

    @Test public void mismatchedCallbackCannotReleaseOwnership() throws Exception {
        Fixture f = new Fixture(); JSONObject request = request(); f.start(request);
        f.gateway.callback.completed(true, f.gateway.interaction + 1);
        assertFalse(f.call("query", request).getBoolean("settled"));
        f.gateway.complete(true); assertTrue(f.receipt(request).getBoolean("ok"));
    }

    @Test public void binderTransportExceptionRemainsUnknownUntilOriginalCallback() throws Exception {
        Fixture f = new Fixture(); f.gateway.throwAfterDispatch = true; JSONObject request = request(); f.start(request);
        assertEquals("unknown", f.call("query", request).getString("phase"));
        assertFalse(f.call("cancel", request).getBoolean("settled"));
        f.gateway.complete(true); assertTrue(f.receipt(request).getBoolean("ok")); assertEquals(1, f.gateway.dispatches);
    }

    @Test public void missingActionCancellationSealsDelayedPrepareAndStart() throws Exception {
        Fixture f = new Fixture(); JSONObject request = request(); JSONObject cancel = f.call("cancel", request);
        assertTrue(cancel.getBoolean("settled"));
        assertEquals(cancel.toString(), f.call("prepare", request).toString());
        assertEquals(cancel.toString(), f.call("start", request).toString());
        assertEquals(0, f.worker.jobs.size()); assertEquals(0, f.gateway.dispatches);
        assertFalse(f.receipt(request).getBoolean("dispatched"));
    }

    @Test public void queuedCancellationWinsBeforeWorkerAdmission() throws Exception {
        Fixture f = new Fixture(); JSONObject request = request(); f.call("prepare", request); f.call("start", request);
        f.call("cancel", request); f.worker.run();
        assertEquals(0, f.gateway.dispatches); assertEquals("cancelled", f.receipt(request).getString("error"));
    }

    @Test public void cancellationDuringValidationPreventsDispatch() throws Exception {
        Fixture f = new Fixture(); JSONObject request = request();
        f.gateway.duringValidation = () -> { try { f.call("cancel", request); } catch (Exception error) { throw new AssertionError(error); } };
        f.start(request); assertEquals(0, f.gateway.dispatches); assertFalse(f.receipt(request).getBoolean("dispatched"));
    }

    @Test public void expiryBeforeStartAndAfterValidationCannotDispatch() throws Exception {
        Fixture before = new Fixture(); JSONObject first = request(); before.call("prepare", first); before.clock.set(1100);
        before.call("start", first); assertEquals(0, before.worker.jobs.size());
        assertEquals("deadline_exceeded", before.receipt(first).getString("error"));
        Fixture during = new Fixture(); JSONObject second = request(); during.gateway.duringValidation = () -> during.clock.set(1100);
        during.start(second); assertEquals(0, during.gateway.dispatches);
        assertEquals("deadline_exceeded", during.receipt(second).getString("error"));
    }

    @Test public void validationFailureProducesNonDispatchReceipt() throws Exception {
        Fixture f = new Fixture(); f.gateway.validationError = "uia_foreground_changed"; JSONObject request = request(); f.start(request);
        assertFalse(f.receipt(request).getBoolean("dispatched"));
        assertEquals("uia_foreground_changed", f.receipt(request).getString("error"));
    }

    @Test public void requestIdentityConflictCannotReplaceOriginalAction() throws Exception {
        Fixture f = new Fixture(); JSONObject original = request(); f.call("prepare", original);
        JSONObject changed = new JSONObject(original.toString()).put("timeoutMs", 5000);
        assertEquals("uia_action_identity_conflict", assertThrows(Wire.Failure.class, () -> f.call("start", changed)).code);
        f.call("cancel", original); assertEquals(1, f.disk.size());
    }

    @Test public void invalidHashEpochTypesAndFieldsNeverAllocateActions() throws Exception {
        Fixture f = new Fixture(); JSONObject request = request();
        assertThrows(Wire.Failure.class, () -> f.engine.prepare(request.toString(), "0".repeat(64)));
        JSONObject epoch = new JSONObject(request.toString()).put("runtimeEpoch", UUID.randomUUID().toString());
        assertEquals("uia_runtime_identity_mismatch", assertThrows(Wire.Failure.class, () -> f.call("prepare", epoch)).code);
        JSONObject stringNumber = new JSONObject(request.toString()).put("timeoutMs", "1000");
        assertThrows(Wire.Failure.class, () -> f.call("prepare", stringNumber));
        JSONObject extra = new JSONObject(request.toString()).put("x", 10);
        assertThrows(Wire.Failure.class, () -> f.call("prepare", extra));
        assertEquals(0, f.engine.status().getInt("count"));
    }

    @Test public void originalIntentAndScriptIdsRemainExactWithoutUuidRemapping() throws Exception {
        Fixture f = new Fixture(); JSONObject request = request().put("actionId", "intent:回归/decision-1");
        f.call("cancel", request);
        assertEquals("intent:回归/decision-1", f.receipt(request).getString("actionId"));
        assertTrue(f.disk.containsKey("intent:回归/decision-1"));
        JSONObject malformed = request().put("actionId", "broken-\uD800");
        assertThrows(Wire.Failure.class, () -> f.call("prepare", malformed));
        assertEquals(1, f.engine.status().getInt("count"));
    }

    @Test public void preparePersistenceFailureCannotAdmitAction() throws Exception {
        Fixture f = new Fixture(); f.failingPhase = "prepared"; JSONObject request = request();
        assertFalse(f.call("prepare", request).getBoolean("settled"));
        assertEquals("uia_journal_write_failed", f.call("start", request).getString("error"));
        assertEquals(0, f.worker.jobs.size()); assertEquals(0, f.gateway.dispatches);
        f.failingPhase = null; f.call("cancel", request); assertFalse(f.receipt(request).getBoolean("dispatched"));
    }

    @Test public void failedAdmissionCommitSettlesWithoutCallingPlatform() throws Exception {
        Fixture f = new Fixture(); f.failingPhase = "admitted"; JSONObject request = request(); f.start(request);
        assertEquals(0, f.gateway.dispatches);
        assertEquals("uia_journal_write_failed", f.receipt(request).getString("error"));
        assertFalse(f.receipt(request).getBoolean("dispatched"));
    }

    @Test public void failedCompletionCommitBlocksNextActionUntilExactReceiptIsSaved() throws Exception {
        Fixture f = new Fixture(); JSONObject first = request(), second = request(); f.start(first);
        f.failingPhase = "terminal"; f.gateway.complete(true);
        assertFalse(f.call("query", first).getBoolean("settled"));
        assertEquals("admitted", f.disk.get(first.getString("actionId")).getString("phase"));
        f.call("prepare", second); assertEquals("uia_runtime_busy", f.call("start", second).getString("error"));
        assertFalse(f.engine.beginClose());
        f.failingPhase = null; assertTrue(f.receipt(first).getBoolean("ok"));
        f.call("start", second); f.worker.run(); f.gateway.complete(false);
        assertEquals(2, f.gateway.dispatches); assertTrue(f.receipt(first).getBoolean("ok"));
    }

    @Test public void receiptAcknowledgementIsExactAndDoesNotAllowReplayOrUnboundedEviction() throws Exception {
        Fixture f = new Fixture(1); JSONObject request = request(); f.call("cancel", request);
        String raw = request.toString(), hash = Wire.sha256(raw);
        assertThrows(Wire.Failure.class, () -> f.engine.acknowledge(raw, hash, "wrong"));
        JSONObject terminal = f.call("query", request);
        assertTrue(f.engine.acknowledge(raw, hash, terminal.getString("receiptSha256")).getBoolean("acknowledged"));
        f.call("start", request); assertEquals(0, f.gateway.dispatches);
        assertEquals("uia_action_capacity_exhausted", assertThrows(Wire.Failure.class, () -> f.call("prepare", request())).code);
        assertTrue(f.engine.beginClose());
    }

    @Test public void explicitCloseRejectsNewActionsAndPreservesReceipts() throws Exception {
        Fixture f = new Fixture(); JSONObject request = request(); f.call("cancel", request);
        assertTrue(f.engine.beginClose()); assertTrue(f.call("query", request).getBoolean("settled"));
        assertEquals("uia_runtime_closing", assertThrows(Wire.Failure.class, () -> f.call("prepare", request())).code);
    }

    @Test public void atomicFilesReopenExactOriginalReceipt() throws Exception {
        Path directory = Files.createTempDirectory("aab-uia-journal-test-");
        Path record = directory.resolve("action.json");
        try {
            JvmPosix.FILES.write((record).toFile() , "{\"phase\":\"prepared\"}");
            JvmPosix.FILES.write((record).toFile() , "{\"phase\":\"terminal\",\"receipt\":\"原始回执\"}");
            assertEquals("原始回执", new JSONObject(DurableFiles.read((record).toFile(), 1024)).getString("receipt"));
            try (java.util.stream.Stream<Path> files = Files.list(directory)) { assertEquals(1, files.count()); }
        } finally { Files.deleteIfExists(record); Files.deleteIfExists(directory); }
    }
}
