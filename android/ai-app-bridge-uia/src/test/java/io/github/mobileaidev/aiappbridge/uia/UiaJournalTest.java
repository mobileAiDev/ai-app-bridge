package io.github.mobileaidev.aiappbridge.uia;

import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.UUID;
import static org.junit.Assert.*;

public class UiaJournalTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    private static final String HASH = "a".repeat(64), OLD_HASH = "b".repeat(64);
    private Path root() throws Exception { return temporary.newFolder().toPath().toRealPath(); }

    private static final class Session {
        final Path path;
        final String boot = UUID.randomUUID().toString(), epoch = UUID.randomUUID().toString();
        final UiaActionEngine engine;
        JSONObject record;
        Path file;
        Session(Path root) throws Exception {
            this(root, Runnable::run);
        }
        Session(Path root, java.util.concurrent.Executor worker) throws Exception {
            path = root.resolve("sessions").resolve(epoch); JvmPosix.FILES.directory((path.resolve("actions")).toFile());
            JvmPosix.FILES.write((path.resolve("runtime.json")).toFile() , new JSONObject().put("schemaVersion", "aab.uia.runtime.v1")
                .put("bootId", boot).put("runtimeEpoch", epoch).put("dexSha256", HASH).put("apiLevel", 36).put("pid", 123)
                .put("socketName", "aab-uia-" + epoch).put("token", HASH).put("sessionPath", path.toString()).put("running", false).toString());
            engine = new UiaActionEngine(boot, epoch, 256, (id, value) -> {
                record = new JSONObject(value.toString()); file = path.resolve("actions").resolve(Wire.sha256(id) + ".json");
                JvmPosix.FILES.write((file).toFile() , value.toString());
            }, new UiaActionEngine.Gateway() {
                @Override public JSONObject validate(JSONObject request) throws Exception {
                    JSONObject target = new JSONObject().put("sourceId", "7").put("windowId", 3).put("text", "Increment")
                        .put("packageName", "example.uia").put("enabled", true).put("visible", true).put("clickable", true);
                    JSONObject selected = request.getJSONObject("target");
                    return new JSONObject().put("snapshotId", selected.get("snapshotId")).put("ref", selected.get("ref"))
                        .put("selector", selected.get("selector")).put("clickPolicy", request.get("clickPolicy"))
                        .put("target", target).put("actionTarget", new JSONObject(target.toString()))
                        .put("window", new JSONObject().put("id", 3).put("displayId", 0).put("focused", true))
                        .put("identityStrength", "same_connection_node_and_reobserved_attributes");
                }
                @Override public boolean dispatch(JSONObject binding, int id, UiaActionEngine.Callback callback) {
                    callback.completed(true, id); return true;
                }
            }, worker, () -> 100);
        }
        JSONObject request() throws Exception {
            return new JSONObject().put("schemaVersion", Wire.EXECUTION).put("bootId", boot).put("runtimeEpoch", epoch)
                .put("actionId", "script:回归/" + UUID.randomUUID()).put("timeoutMs", 1000).put("clickPolicy", "nearest_clickable_ancestor")
                .put("target", new JSONObject().put("snapshotId", UUID.randomUUID().toString()).put("ref", UUID.randomUUID().toString())
                    .put("selector", new JSONObject().put("kind", "text").put("value", "Increment").put("exact", true).put("packageName", "example.uia")));
        }
        void prepare(boolean queued) throws Exception {
            String raw = request().toString(), hash = Wire.sha256(raw);
            engine.prepare(raw, hash); if (queued) engine.start(raw, hash);
        }
        void add(boolean acknowledged, boolean click) throws Exception {
            add(request(), acknowledged, click);
        }
        void add(JSONObject request, boolean acknowledged, boolean click) throws Exception {
            String raw = request.toString(), hash = Wire.sha256(raw);
            if (click) { engine.prepare(raw, hash); engine.start(raw, hash); } else engine.cancel(raw, hash);
            if (acknowledged) engine.acknowledge(raw, hash, record.getString("receiptSha256"));
        }
        void save() throws Exception { JvmPosix.FILES.write((file).toFile() , record.toString()); }
        JSONObject identity() throws Exception {
            return new JSONObject().put("bootId", boot).put("runtimeEpoch", epoch).put("actionSha256", Wire.sha256(record.getString("actionId")))
                .put("requestSha256", record.getString("requestSha256")).put("receiptSha256", record.getString("receiptSha256"))
                .put("originalDexSha256", HASH);
        }
        JSONObject recoveryIdentity() throws Exception {
            return new JSONObject().put("bootId", boot).put("runtimeEpoch", epoch).put("actionSha256", Wire.sha256(record.getString("actionId")))
                .put("requestSha256", record.getString("requestSha256")).put("originalDexSha256", HASH);
        }
    }

    @Test public void nodeReferenceCallbackSurvivesAuditAndCanBeAcknowledgedThenRetired() throws Exception {
        Path root = root(); Session session = new Session(root);
        JSONObject request = session.request(), target = request.getJSONObject("target");
        target.getJSONObject("selector").put("kind", "nodeRef").put("value", target.getString("ref"));
        session.add(request, false, true);
        String original = DurableFiles.read((session.file).toFile(), 131072);
        JSONObject binding = new JSONObject(session.record.getString("receiptJson")).getJSONObject("binding");
        assertFalse(binding.getJSONObject("target").has("nodeRef"));
        new UiaJournal(root.toFile(), JvmPosix.FILES).prepare(HASH);
        assertEquals(original, DurableFiles.read((session.file).toFile(), 131072));
        assertEquals("acknowledged", new UiaJournal(root.toFile(), JvmPosix.FILES).acknowledge(session.identity(), null).getString("disposition"));
        new UiaJournal(root.toFile(), JvmPosix.FILES).prepare(HASH);
        assertFalse(Files.exists(session.path));
    }

    @Test public void changedNodeReferenceCannotAuthorizeOriginalSessionRetirement() throws Exception {
        Path root = root(); Session session = new Session(root);
        JSONObject request = session.request(), target = request.getJSONObject("target");
        target.getJSONObject("selector").put("kind", "nodeRef").put("value", target.getString("ref"));
        session.add(request, true, true);
        JSONObject receipt = new JSONObject(session.record.getString("receiptJson"));
        receipt.getJSONObject("binding").put("ref", UUID.randomUUID().toString());
        session.record.put("receiptJson", receipt.toString()).put("receiptSha256", Wire.sha256(receipt.toString()));
        session.save();
        String original = DurableFiles.read((session.file).toFile(), 131072);
        assertEquals("uia_completion_identity_mismatch", assertThrows(Wire.Failure.class,
            () -> new UiaJournal(root.toFile(), JvmPosix.FILES).prepare(HASH)).code);
        assertEquals(original, DurableFiles.read((session.file).toFile(), 131072));
    }

    @Test public void acknowledgedSessionsRotateBeyondTheOldSixtyFourSessionLimit() throws Exception {
        Path root = root();
        for (int i = 0; i < 64; i++) { Session session = new Session(root); session.add(true, i % 2 == 0); }
        new UiaJournal(root.toFile(), JvmPosix.FILES).prepare(HASH);
        assertEquals(0, root.resolve("sessions").toFile().list().length);
        assertEquals(0, root.resolve("retired").toFile().list().length);
        Session next = new Session(root); next.add(true, true); new UiaJournal(root.toFile(), JvmPosix.FILES).prepare(HASH);
        assertFalse(Files.exists(next.path));
    }

    @Test public void unacknowledgedOriginalBytesSurviveWhileAcknowledgedSessionsAndOldExecutablesRetire() throws Exception {
        Path root = root(); Session retained = new Session(root), removed = new Session(root);
        retained.add(false, true); removed.add(true, false);
        String original = "\n  " + retained.record.toString() + "\n"; JvmPosix.FILES.write((retained.file).toFile() , original);
        Path current = root.resolve("runtime-" + HASH + ".jar"), old = root.resolve("runtime-" + OLD_HASH + ".jar");
        Files.write(current, new byte[]{1}); Files.write(old, new byte[]{2});
        new UiaJournal(root.toFile(), JvmPosix.FILES).prepare(HASH);
        assertEquals(original, DurableFiles.read((retained.file).toFile(), 131072));
        assertFalse(Files.exists(removed.path)); assertFalse(Files.exists(old)); assertTrue(Files.exists(current));
        new UiaJournal(root.toFile(), JvmPosix.FILES).prepare(HASH); assertEquals(original, DurableFiles.read((retained.file).toFile(), 131072));
    }

    @Test public void oneUnacknowledgedActionRetainsTheEntireSession() throws Exception {
        Path root = root(); Session session = new Session(root);
        session.add(true, true); Path first = session.file; session.add(false, false);
        new UiaJournal(root.toFile(), JvmPosix.FILES).prepare(HASH);
        assertTrue(Files.exists(first)); assertTrue(Files.exists(session.file));
    }

    @Test public void everyNonterminalPhaseBlocksReopenAndAllOriginalReclamation() throws Exception {
        for (String phase : new String[]{"prepared", "queued", "admitted", "unknown"}) {
            Path root = root(); Session good = new Session(root), pending = new Session(root);
            good.add(true, true); pending.add(false, true);
            pending.record.put("phase", phase).put("receiptJson", JSONObject.NULL).put("receiptSha256", JSONObject.NULL); pending.save();
            String bytes = DurableFiles.read((pending.file).toFile(), 131072);
            Wire.Failure error = assertThrows(Wire.Failure.class, () -> new UiaJournal(root.toFile(), JvmPosix.FILES).prepare(HASH));
            assertEquals("uia_previous_action_unresolved", error.code);
            assertEquals(bytes, DurableFiles.read((pending.file).toFile(), 131072)); assertTrue(Files.exists(good.file));
        }
    }

    @Test public void temporaryCompletionCannotPromoteAnUnknownCommittedRecord() throws Exception {
        Path root = root(); Session session = new Session(root); session.add(false, true);
        Path leftover = session.file.resolveSibling(session.file.getFileName() + "." + UUID.randomUUID() + ".tmp");
        JvmPosix.FILES.write((leftover).toFile() , session.record.toString());
        session.record.put("phase", "unknown").put("receiptJson", JSONObject.NULL).put("receiptSha256", JSONObject.NULL); session.save();
        assertEquals("uia_previous_action_unresolved", assertThrows(Wire.Failure.class, () -> new UiaJournal(root.toFile(), JvmPosix.FILES).prepare(HASH)).code);
        assertTrue(Files.exists(leftover)); assertTrue(Files.exists(session.file));
    }

    @Test public void corruptIdentityRequestAcknowledgementOrReceiptNeverAuthorizesDeletion() throws Exception {
        for (String fault : new String[]{"ack-string", "record-id", "request-hash", "request-shape", "receipt-hash", "receipt-id", "callback", "binding", "time", "extra"}) {
            Path root = root(); Session good = new Session(root), bad = new Session(root); good.add(true, true); bad.add(true, true);
            JSONObject receipt = new JSONObject(bad.record.getString("receiptJson"));
            switch (fault) {
                case "ack-string": bad.record.put("acknowledged", "true"); break;
                case "record-id": bad.record.put("actionId", "different"); break;
                case "request-hash": bad.record.put("requestSha256", OLD_HASH); break;
                case "request-shape":
                    JSONObject request = new JSONObject(bad.record.getString("requestJson")); request.put("timeoutMs", "1000");
                    String raw = request.toString(), hash = Wire.sha256(raw);
                    bad.record.put("requestJson", raw).put("requestSha256", hash); receipt.put("requestSha256", hash); break;
                case "receipt-hash": bad.record.put("receiptSha256", OLD_HASH); break;
                case "receipt-id": receipt.put("actionId", "different"); break;
                case "callback": receipt.getJSONObject("callback").put("interactionId", 999); break;
                case "binding": receipt.getJSONObject("binding").put("ref", UUID.randomUUID().toString()); break;
                case "time": receipt.put("completedAtElapsedMs", 1); break;
                case "extra": receipt.put("anything", true); break;
                default: throw new AssertionError(fault);
            }
            if (!fault.equals("receipt-hash")) bad.record.put("receiptJson", receipt.toString()).put("receiptSha256", Wire.sha256(receipt.toString()));
            bad.save(); String original = DurableFiles.read((bad.file).toFile(), 131072);
            assertThrows(Exception.class, () -> new UiaJournal(root.toFile(), JvmPosix.FILES).prepare(HASH));
            assertEquals(original, DurableFiles.read((bad.file).toFile(), 131072)); assertTrue(fault, Files.exists(good.file));
        }
    }

    @Test public void restartFinishesDeletionAfterDurableRetirementAndPartialErase() throws Exception {
        Path root = root(); Session session = new Session(root); session.add(true, true); session.add(true, false);
        Path retired = root.resolve("retired"); JvmPosix.FILES.directory((retired).toFile());
        Path moved = retired.resolve(session.epoch); Files.move(session.path, moved, StandardCopyOption.ATOMIC_MOVE);
        JvmPosix.FILES.syncDirectory((root.resolve("sessions")).toFile()); JvmPosix.FILES.syncDirectory((retired).toFile());
        Files.delete(moved.resolve("actions").resolve(session.file.getFileName())); Files.delete(moved.resolve("runtime.json"));
        Session retained = new Session(root); retained.add(false, true); String proof = DurableFiles.read((retained.file).toFile(), 131072);
        new UiaJournal(root.toFile(), JvmPosix.FILES).prepare(HASH);
        assertFalse(Files.exists(moved)); assertEquals(proof, DurableFiles.read((retained.file).toFile(), 131072));
    }

    @Test public void interruptedEmptyConstructionIsReclaimable() throws Exception {
        Path root = root(); Path session = root.resolve("sessions").resolve(UUID.randomUUID().toString());
        JvmPosix.FILES.directory((session).toFile());
        new UiaJournal(root.toFile(), JvmPosix.FILES).prepare(HASH); assertFalse(Files.exists(session));
    }

    @Test public void sessionAndActionSymlinksNeverPermitExternalDeletion() throws Exception {
        Path root = root(), outside = root(); Session session = new Session(root); session.add(true, true);
        Path protectedFile = outside.resolve(session.file.getFileName()); Files.move(session.file, protectedFile);
        Files.createSymbolicLink(session.file, protectedFile);
        assertThrows(Exception.class, () -> new UiaJournal(root.toFile(), JvmPosix.FILES).prepare(HASH)); assertTrue(Files.exists(protectedFile));
        Path second = root(); JvmPosix.FILES.directory((second.resolve("sessions")).toFile());
        Files.createSymbolicLink(second.resolve("sessions").resolve(session.epoch), session.path);
        assertThrows(Exception.class, () -> new UiaJournal(second.toFile(), JvmPosix.FILES).prepare(HASH)); assertTrue(Files.exists(protectedFile));
    }

    @Test public void retainedCapacityNeverEvictsAnUnacknowledgedSession() throws Exception {
        Path root = root();
        for (int i = 0; i < 64; i++) { Session session = new Session(root); session.add(false, false); }
        assertEquals("uia_session_capacity_exhausted", assertThrows(Wire.Failure.class, () -> new UiaJournal(root.toFile(), JvmPosix.FILES).prepare(HASH)).code);
        assertEquals(64, root.resolve("sessions").toFile().list().length);
    }

    @Test public void stoppedAcknowledgementPreservesOriginalBytesAndRetiresOnlyOnNextPrepare() throws Exception {
        Path root = root(); Session session = new Session(root); session.add(false, true);
        JSONObject identity = session.identity();
        String request = session.record.getString("requestJson"), receipt = session.record.getString("receiptJson");
        UiaJournal journal = new UiaJournal(root.toFile(), JvmPosix.FILES);
        assertEquals("acknowledged", journal.acknowledge(identity, null).getString("disposition"));
        JSONObject saved = new JSONObject(DurableFiles.read((session.file).toFile(), 131072));
        assertEquals(request, saved.getString("requestJson")); assertEquals(receipt, saved.getString("receiptJson")); assertTrue(saved.getBoolean("acknowledged"));
        assertTrue(Files.exists(session.path));
        assertEquals("acknowledged", journal.acknowledge(identity, UUID.randomUUID().toString()).getString("disposition"));
        journal.prepare(HASH); assertFalse(Files.exists(session.path));
        JSONObject retired = journal.acknowledge(identity, null);
        assertEquals("not_retained", retired.getString("disposition")); assertEquals(4, retired.length());
        assertFalse(retired.has("settled")); assertFalse(retired.has("receiptJson"));
    }

    @Test public void acknowledgingKnownHistoryNeverSettlesOrDeletesAnotherUnknownAction() throws Exception {
        Path root = root(); Session known = new Session(root), unknown = new Session(root);
        known.add(false, true); unknown.add(false, true);
        unknown.record.put("phase", "unknown").put("receiptJson", JSONObject.NULL).put("receiptSha256", JSONObject.NULL); unknown.save();
        String original = DurableFiles.read((unknown.file).toFile(), 131072);
        assertEquals("acknowledged", new UiaJournal(root.toFile(), JvmPosix.FILES).acknowledge(known.identity(), null).getString("disposition"));
        assertEquals("uia_previous_action_unresolved", assertThrows(Wire.Failure.class, () -> new UiaJournal(root.toFile(), JvmPosix.FILES).prepare(HASH)).code);
        assertTrue(Files.exists(known.file)); assertEquals(original, DurableFiles.read((unknown.file).toFile(), 131072));
    }

    @Test public void maintenanceNeverWritesTheActiveEngineEvenWhenItsFileIsAbsent() throws Exception {
        Path root = root(); Session session = new Session(root); session.add(false, true);
        JSONObject identity = session.identity(); String original = DurableFiles.read((session.file).toFile(), 131072);
        assertEquals("uia_active_session_requires_engine", assertThrows(Wire.Failure.class,
            () -> new UiaJournal(root.toFile(), JvmPosix.FILES).acknowledge(identity, session.epoch)).code);
        assertEquals(original, DurableFiles.read((session.file).toFile(), 131072)); Files.delete(session.file);
        assertEquals("uia_active_session_requires_engine", assertThrows(Wire.Failure.class,
            () -> new UiaJournal(root.toFile(), JvmPosix.FILES).acknowledge(identity, session.epoch)).code);
    }

    @Test public void invalidMaintenanceProofOrNonterminalOriginalNeverChangesAcknowledgement() throws Exception {
        for (String fault : new String[]{"bootId", "requestSha256", "receiptSha256", "originalDexSha256", "phase", "receipt", "path"}) {
            Path root = root(); Session session = new Session(root); session.add(false, true); JSONObject identity = session.identity();
            switch (fault) {
                case "bootId": identity.put(fault, UUID.randomUUID().toString()); break;
                case "phase": session.record.put("phase", "admitted"); session.save(); break;
                case "receipt": session.record.put("receiptJson", "{}"); session.save(); break;
                case "path": identity.put("actionSha256", "../protected"); break;
                default: identity.put(fault, OLD_HASH);
            }
            String original = DurableFiles.read((session.file).toFile(), 131072);
            assertThrows(Exception.class, () -> new UiaJournal(root.toFile(), JvmPosix.FILES).acknowledge(identity, null));
            assertEquals(fault, original, DurableFiles.read((session.file).toFile(), 131072));
        }
    }

    @Test public void maintenanceRejectsActionAndDescriptorSymlinksWithoutTouchingTheirTargets() throws Exception {
        for (String name : new String[]{"action", "descriptor"}) {
            Path root = root(); Session session = new Session(root); session.add(false, true); JSONObject identity = session.identity();
            Path file = name.equals("action") ? session.file : session.path.resolve("runtime.json");
            Path outside = root().resolve("protected.json"); Files.move(file, outside); Files.createSymbolicLink(file, outside);
            String original = DurableFiles.read((outside).toFile(), 131072);
            assertThrows(Exception.class, () -> new UiaJournal(root.toFile(), JvmPosix.FILES).acknowledge(identity, null));
            assertEquals(original, DurableFiles.read((outside).toFile(), 131072));
        }
    }

    @Test public void deadOwnerPreparedAndQueuedRecordsRecoverWithoutDispatchAndRetainTheFirstCredential() throws Exception {
        for (boolean queued : new boolean[]{false, true}) {
            Path root = root(); Session session = new Session(root, work -> {}); session.prepare(queued);
            String prior = DurableFiles.read((session.file).toFile(), 131072), request = session.record.getString("requestJson");
            JSONObject identity = session.recoveryIdentity(); UiaJournal journal = new UiaJournal(root.toFile(), JvmPosix.FILES);
            session.record = journal.recover(identity, session.boot, 150, OLD_HASH);
            JSONObject receipt = new JSONObject(session.record.getString("receiptJson")), recovery = receipt.getJSONObject("recovery");
            assertEquals("recovered_before_admission", receipt.getString("completion")); assertFalse(receipt.getBoolean("dispatched"));
            assertFalse(receipt.has("callback")); assertFalse(receipt.has("completedAtElapsedMs"));
            assertEquals(queued ? "queued" : "prepared", recovery.getString("priorPhase"));
            assertEquals(Wire.sha256(prior), recovery.getString("priorRecordSha256"));
            assertEquals(request, session.record.getString("requestJson")); assertEquals(100, session.record.getLong("preparedAtElapsedMs"));
            assertEquals(1100, session.record.getLong("deadlineElapsedMs")); assertFalse(session.record.getBoolean("acknowledged"));
            assertEquals(receipt.toString(), journal.recover(identity, UUID.randomUUID().toString(), 5, HASH).getString("receiptJson"));
            journal.prepare(HASH); assertTrue(Files.exists(session.file));
            journal.acknowledge(session.identity(), null); journal.prepare(HASH); assertFalse(Files.exists(session.path));
        }
    }

    @Test public void recoverySeparatesBootClocksAndNeverFabricatesAnOriginalCompletionTime() throws Exception {
        Path root = root(); Session session = new Session(root); session.prepare(false); UiaJournal journal = new UiaJournal(root.toFile(), JvmPosix.FILES);
        JSONObject identity = session.recoveryIdentity(); String original = DurableFiles.read((session.file).toFile(), 131072);
        assertThrows(Exception.class, () -> journal.recover(identity, session.boot, 5, HASH));
        assertEquals(original, DurableFiles.read((session.file).toFile(), 131072));
        String nextBoot = UUID.randomUUID().toString();
        JSONObject record = journal.recover(identity, nextBoot, 5, HASH), receipt = new JSONObject(record.getString("receiptJson"));
        assertEquals(session.boot, receipt.getString("bootId")); assertEquals(nextBoot, receipt.getJSONObject("recovery").getString("bootId"));
        assertEquals(5, receipt.getJSONObject("recovery").getLong("observedAtElapsedMs"));
        assertEquals(100, record.getLong("preparedAtElapsedMs")); assertFalse(receipt.has("completedAtElapsedMs"));
        journal.prepare(HASH); assertTrue(Files.exists(session.file));
    }

    @Test public void admittedAndUnknownRecordsStayUnknownAcrossDeathAndReboot() throws Exception {
        for (String phase : new String[]{"admitted", "unknown"}) {
            Path root = root(); Session session = new Session(root); session.add(false, true);
            session.record.put("phase", phase).put("receiptJson", JSONObject.NULL).put("receiptSha256", JSONObject.NULL); session.save();
            String original = DurableFiles.read((session.file).toFile(), 131072); JSONObject identity = session.recoveryIdentity();
            for (String boot : new String[]{session.boot, UUID.randomUUID().toString()}) {
                assertEquals("uia_previous_action_unresolved", assertThrows(Wire.Failure.class,
                    () -> new UiaJournal(root.toFile(), JvmPosix.FILES).recover(identity, boot, 500, HASH)).code);
                assertEquals(original, DurableFiles.read((session.file).toFile(), 131072));
            }
        }
    }

    @Test public void absentOriginalRecordNeverCreatesARecoveryTombstone() throws Exception {
        Path root = root(); Session session = new Session(root); session.prepare(false);
        JSONObject identity = session.recoveryIdentity(); Files.delete(session.file);
        assertEquals("uia_original_action_record_not_retained", assertThrows(Wire.Failure.class,
            () -> new UiaJournal(root.toFile(), JvmPosix.FILES).recover(identity, session.boot, 500, HASH)).code);
        assertFalse(Files.exists(session.file));
    }

    @Test public void conflictingRecoveryIdentityOrInvalidPendingStateCannotRewriteOriginalBytes() throws Exception {
        for (String fault : new String[]{"bootId", "requestSha256", "originalDexSha256", "path", "admitted-id", "ack", "receipt", "deadline"}) {
            Path root = root(); Session session = new Session(root); session.prepare(false); JSONObject identity = session.recoveryIdentity();
            switch (fault) {
                case "bootId": identity.put(fault, UUID.randomUUID().toString()); break;
                case "path": identity.put("actionSha256", "../outside"); break;
                case "admitted-id": session.record.put("interactionId", 1); break;
                case "ack": session.record.put("acknowledged", true); break;
                case "receipt": session.record.put("receiptJson", "{}"); break;
                case "deadline": session.record.put("deadlineElapsedMs", 100); break;
                default: identity.put(fault, OLD_HASH);
            }
            session.save(); String original = DurableFiles.read((session.file).toFile(), 131072);
            assertThrows(Exception.class, () -> new UiaJournal(root.toFile(), JvmPosix.FILES).recover(identity, session.boot, 500, HASH));
            assertEquals(fault, original, DurableFiles.read((session.file).toFile(), 131072));
        }
    }

    @Test public void recoveryDoesNotTouchAnotherUnresolvedActionOrAnExistingOriginalCallback() throws Exception {
        Path root = root(); Session pending = new Session(root), known = new Session(root);
        pending.prepare(false); known.add(false, true); String originalCallback = known.record.getString("receiptJson");
        JSONObject original = new UiaJournal(root.toFile(), JvmPosix.FILES).recover(known.recoveryIdentity(), known.boot, 500, HASH);
        assertEquals(originalCallback, original.getString("receiptJson"));
        known.record.put("phase", "unknown").put("receiptJson", JSONObject.NULL).put("receiptSha256", JSONObject.NULL); known.save();
        String unknown = DurableFiles.read((known.file).toFile(), 131072);
        new UiaJournal(root.toFile(), JvmPosix.FILES).recover(pending.recoveryIdentity(), pending.boot, 500, HASH);
        assertEquals(unknown, DurableFiles.read((known.file).toFile(), 131072));
        assertEquals("uia_previous_action_unresolved", assertThrows(Wire.Failure.class, () -> new UiaJournal(root.toFile(), JvmPosix.FILES).prepare(HASH)).code);
    }

    @Test public void recoveryRejectsSymlinksAndMalformedRecoveryCredentials() throws Exception {
        Path root = root(); Session session = new Session(root); session.prepare(false); JSONObject identity = session.recoveryIdentity();
        Path outside = root().resolve("protected.json"); Files.move(session.file, outside); Files.createSymbolicLink(session.file, outside);
        String original = DurableFiles.read((outside).toFile(), 131072);
        assertThrows(Exception.class, () -> new UiaJournal(root.toFile(), JvmPosix.FILES).recover(identity, session.boot, 500, HASH));
        assertEquals(original, DurableFiles.read((outside).toFile(), 131072));
        Files.delete(session.file); Files.move(outside, session.file);
        session.record = new UiaJournal(root.toFile(), JvmPosix.FILES).recover(identity, session.boot, 500, HASH);
        JSONObject receipt = new JSONObject(session.record.getString("receiptJson"));
        receipt.getJSONObject("recovery").put("priorPhase", "admitted");
        session.record.put("receiptJson", receipt.toString()).put("receiptSha256", Wire.sha256(receipt.toString())); session.save();
        String malformed = DurableFiles.read((session.file).toFile(), 131072);
        assertThrows(Exception.class, () -> new UiaJournal(root.toFile(), JvmPosix.FILES).acknowledge(session.identity(), null));
        assertThrows(Exception.class, () -> new UiaJournal(root.toFile(), JvmPosix.FILES).prepare(HASH));
        assertEquals(malformed, DurableFiles.read((session.file).toFile(), 131072));
    }
}
