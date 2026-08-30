#!/usr/bin/env node
"use strict";

// THROWAWAY real-device experiment. This file deliberately imports the current
// workspace CLI implementation instead of using a possibly stale MCP process.
const { executeCommand } = require("../bin/ai-app-bridge.js");

const TARGET = Object.freeze({
    serial: process.env.AI_APP_BRIDGE_SERIAL || "",
    packageName: "io.github.mobileaidev.aiappbridge.sample",
    activity: ".intentfixture.IntentLoginFixtureActivity",
});

const ACCOUNT = "fixture@example.com";
const PASSWORD_CANARY = "intent-secret-canary-73B9";
const FIXTURE_ID_PREFIX = `${TARGET.packageName}:id/intent_fixture_`;

const SCENARIOS = Object.freeze([
    {
        name: "complex-success",
        extras: {
            start: "welcome",
            outcome: "success",
            delay_ms: "350",
            duplicate_submit: "true",
            animate: "true",
            dialog: "true",
        },
        summary: "start=welcome outcome=success duplicate-label animated dialog",
        expected: { kind: "success", oracleReason: "authenticated" },
        oracleTimeoutMs: 4_000,
    },
    {
        name: "already-authenticated",
        extras: { start: "home", outcome: "success" },
        startDescription: "authenticated_home",
        expected: { kind: "success", oracleReason: "already_authenticated" },
        oracleTimeoutMs: 1_000,
    },
    {
        name: "invalid-credentials",
        extras: { start: "login", outcome: "invalid", delay_ms: "300" },
        summary: "start=login outcome=invalid_credentials",
        expected: {
            kind: "failure",
            executionReason: "invalid-credentials",
            oracleReason: "invalid_credentials",
        },
        oracleTimeoutMs: 4_000,
    },
    {
        name: "agreement-unchecked",
        extras: { start: "login", outcome: "success", delay_ms: "300", terms_checked: "false" },
        summary: "start=login outcome=success",
        expected: { kind: "success", oracleReason: "authenticated" },
        oracleTimeoutMs: 4_000,
    },
    {
        name: "network-error",
        extras: { start: "login", outcome: "network", delay_ms: "300" },
        summary: "start=login outcome=network_error",
        expected: {
            kind: "failure",
            executionReason: "network-error",
            oracleReason: "network_error",
        },
        oracleTimeoutMs: 4_000,
    },
    {
        name: "otp-required",
        extras: { start: "login", outcome: "otp", delay_ms: "300" },
        summary: "start=login outcome=otp_required",
        expected: {
            kind: "failure",
            executionReason: "needs-user:otp",
            oracleReason: "otp_required",
        },
        oracleTimeoutMs: 4_000,
    },
    {
        name: "network-timeout",
        extras: { start: "login", outcome: "timeout", delay_ms: "8000", animate: "true" },
        summary: "start=login outcome=timeout animated",
        expected: {
            kind: "failure",
            executionReason: "network-timeout",
            oracleReason: "timeout",
        },
        oracleTimeoutMs: 11_000,
    },
]);

const IMPLEMENTATIONS = Object.freeze(["static-known-batch", "login-recipe", "bounded-htn"]);
const TERMINAL_ORACLE_REASONS = new Set([
    "authenticated",
    "already_authenticated",
    "invalid_credentials",
    "network_error",
    "timeout",
    "otp_required",
    "agreement_required",
    "fields_required",
]);

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function midpoint(bounds) {
    return {
        x: Math.round((Number(bounds.left) + Number(bounds.right)) / 2),
        y: Math.round((Number(bounds.top) + Number(bounds.bottom)) / 2),
    };
}

function unique(values) {
    return [...new Set(values)];
}

function safeError(error) {
    return String(error?.message || error || "unknown error").replaceAll(PASSWORD_CANARY, "[REDACTED]");
}

function suffixMatches(resourceName, suffix) {
    return String(resourceName || "").endsWith(`:id/${suffix}`);
}

function latestById(items) {
    return [...(items || [])].sort((left, right) => Number(right.id || 0) - Number(left.id || 0))[0] ?? null;
}

function compactBounds(bounds) {
    if (!bounds) return null;
    return {
        left: Number(bounds.left),
        top: Number(bounds.top),
        right: Number(bounds.right),
        bottom: Number(bounds.bottom),
    };
}

function publicStateOnly(stateCapture) {
    const items = (stateCapture?.items || []).filter(
        (item) => !(item.namespace === "intent_fixture" && item.key === "oracle"),
    );
    const values = {};
    for (const [key, value] of Object.entries(stateCapture?.values || {})) {
        if (key !== "intent_fixture.oracle") values[key] = value;
    }
    return { items, values, count: items.length };
}

function dedupeBridgeNodes(nodes) {
    const selected = new Map();
    for (const node of nodes || []) {
        const key = [
            node.resourceName || "",
            node.contentDescription || "",
            node.text || "",
            JSON.stringify(node.bounds || null),
        ].join("|");
        const prior = selected.get(key);
        if (!prior || (prior.windowType === "root" && node.windowType !== "root")) {
            selected.set(key, node);
        }
    }
    return [...selected.values()];
}

function publicControl(node) {
    const isPassword = suffixMatches(node.resourceName, "intent_fixture_password");
    return {
        resourceName: node.resourceName,
        contentDescription: node.contentDescription,
        text: isPassword ? null : node.text,
        textLength: String(node.text || "").length,
        className: node.className,
        clickable: node.clickable,
        enabled: node.enabled,
        focused: node.focused,
        windowType: node.windowType,
        bounds: compactBounds(node.bounds),
    };
}

function deriveObservation(raw) {
    const nodes = dedupeBridgeNodes(raw.tree?.nodes || []);
    const controls = nodes.map(publicControl);
    const uiaTerms = (raw.uia?.nodes || []).find((node) =>
        suffixMatches(node.resourceId, "intent_fixture_terms"),
    );
    const hasDescription = (description) =>
        controls.some((node) => node.contentDescription === description);
    const statusNode = controls.find((node) =>
        suffixMatches(node.resourceName, "intent_fixture_status"),
    );
    const accountNode = controls.find((node) =>
        suffixMatches(node.resourceName, "intent_fixture_account"),
    );
    const passwordNode = controls.find((node) =>
        suffixMatches(node.resourceName, "intent_fixture_password"),
    );
    const scenarioNode = controls.find((node) =>
        suffixMatches(node.resourceName, "intent_fixture_scenario"),
    );

    let screen = "unknown";
    if (hasDescription("authenticated_home")) screen = "home";
    else if (hasDescription("otp_challenge_message") || hasDescription("screen_verification_required")) {
        screen = "otp";
    } else if (hasDescription("screen_welcome")) screen = "welcome";
    else if (hasDescription("screen_sign_in")) screen = "login";

    let error = null;
    const statusDescription = statusNode?.contentDescription || "";
    if (statusDescription === "login_error_invalid_credentials") error = "invalid-credentials";
    else if (statusDescription === "login_error_network") error = "network-error";
    else if (statusDescription === "login_error_timeout") error = "network-timeout";
    else if (statusDescription === "login_error_terms_required") error = "agreement-required";
    else if (statusDescription === "login_error_fields_required") error = "fields-required";

    const fixtureEvents = (raw.events?.items || [])
        .filter((item) => item.category === "intent_fixture")
        .map((item) => ({
            id: item.id,
            name: item.name,
            data: item.data
                ? {
                      submitCount: item.data.submitCount,
                      accountLength: item.data.accountLength,
                      passwordLength: item.data.passwordLength,
                      termsChecked: item.data.termsChecked,
                      checked: item.data.checked,
                      screen: item.data.screen,
                  }
                : null,
        }));

    return {
        target: {
            serial: TARGET.serial,
            packageName: raw.status?.app?.packageName || TARGET.packageName,
            activity: raw.status?.activity?.current || raw.tree?.activity || null,
            runtimeEpoch: raw.status?.debugBridge?.runtimeEpoch || null,
            model: raw.status?.android?.model || null,
        },
        screen,
        authenticated: screen === "home",
        scenarioSummary: scenarioNode?.text || null,
        dialog: controls.some(
            (node) => node.windowType === "window" && node.text === "Before signing in",
        ),
        keyboardVisible: raw.keyboard?.visible === true,
        form: {
            accountPresent: Boolean(accountNode),
            accountLength: accountNode?.textLength ?? null,
            passwordPresent: Boolean(passwordNode),
            passwordLength: passwordNode?.textLength ?? null,
            agreementPresent: controls.some((node) =>
                suffixMatches(node.resourceName, "intent_fixture_terms"),
            ),
            agreementChecked: uiaTerms ? uiaTerms.checked === true : null,
        },
        error,
        submitting: statusDescription === "login_submitting",
        statusDescription,
        controls,
        fixtureEvents,
        network: (raw.network?.items || []).map((item) => ({
            id: item.id,
            method: item.method,
            url: item.url,
            statusCode: item.statusCode,
            error: item.error,
        })),
        publicStateCount: raw.publicState.count,
        captureCounts: raw.status?.capture || null,
    };
}

function classifyObservation(observation, metrics) {
    if (observation.authenticated) {
        return executionResult("succeeded", "goal-observed", metrics);
    }
    if (observation.screen === "otp") {
        return executionResult("blocked", "needs-user:otp", metrics);
    }
    if (observation.error) {
        return executionResult("failed", observation.error, metrics);
    }
    return null;
}

function executionResult(status, reason, metrics, extra = {}) {
    return { status, reason, metrics: { ...metrics }, ...extra };
}

function baseStrategyMetrics() {
    return { replans: 0, loops: 0 };
}

function controlBySuffix(observation, suffix) {
    return observation.controls.find((node) => suffixMatches(node.resourceName, suffix)) ?? null;
}

class SurfaceAdapter {
    constructor() {
        this.executionActive = false;
        this.targetIdentity = null;
        this.trace = [];
        this.resetMetrics();
    }

    resetMetrics() {
        this.metrics = {
            commands: 0,
            actions: 0,
            observations: 0,
            localizationReads: 0,
            secretLeakOccurrences: 0,
            secretLeakSurfaces: new Set(),
        };
        this.trace = [];
    }

    async command(command, options = {}, surface = command) {
        this.metrics.commands += 1;
        const result = await executeCommand(command, {
            serial: TARGET.serial,
            packageName: TARGET.packageName,
            ...options,
        });
        this.inspectSecretLeak(result, surface);
        return result;
    }

    inspectSecretLeak(result, surface) {
        let encoded;
        try {
            encoded = JSON.stringify(result);
        } catch (_) {
            return;
        }
        if (encoded.includes(PASSWORD_CANARY)) {
            this.metrics.secretLeakOccurrences += 1;
            this.metrics.secretLeakSurfaces.add(surface);
        }
    }

    async prepareScenario(scenario) {
        await this.bestEffortThaw("setup-thaw");
        await this.dismissKnownDialog();
        await this.bestEffortCommand("hide-keyboard", { force: true }, "setup-hide-keyboard");
        await this.bestEffortCommand("keyevent", { keyCode: 4 }, "setup-back-1");
        await sleep(120);
        await this.bestEffortCommand("keyevent", { keyCode: 4 }, "setup-back-2");
        await sleep(180);
        await this.command("clear-app-data", {}, "setup-clear-captures");

        const extra = Object.entries(scenario.extras).map(([key, value]) => `${key}=${value}`);
        let launch = await this.command(
            "launch-activity",
            { activity: TARGET.activity, extra },
            "setup-launch",
        );
        let verified = await this.waitForScenario(scenario, 2_500);
        if (!verified) {
            await this.dismissKnownDialog();
            await this.bestEffortCommand("keyevent", { keyCode: 4 }, "setup-retry-back");
            await sleep(180);
            launch = await this.command(
                "launch-activity",
                { activity: TARGET.activity, extra },
                "setup-retry-launch",
            );
            verified = await this.waitForScenario(scenario, 2_500);
        }
        if (!verified) {
            throw new Error(`fixture scenario did not launch: ${scenario.name}`);
        }

        const status = await this.command("status", { full: true }, "setup-status");
        this.targetIdentity = {
            serial: TARGET.serial,
            packageName: status.app?.packageName || TARGET.packageName,
            activity: status.activity?.current || null,
            runtimeEpoch: status.debugBridge?.runtimeEpoch || null,
            manufacturer: status.android?.manufacturer || null,
            model: status.android?.model || null,
            sdkInt: status.android?.sdkInt || null,
        };
        this.resetMetrics();
        return { launch, target: this.targetIdentity };
    }

    async waitForScenario(scenario, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const tree = await this.command(
                    "tree",
                    { compact: true, visibleOnly: true, maxNodes: 100 },
                    "setup-tree",
                );
                const scenarioNode = (tree.nodes || []).find((node) =>
                    suffixMatches(node.resourceName, "intent_fixture_scenario"),
                );
                const startNode = (tree.nodes || []).find(
                    (node) => node.contentDescription === scenario.startDescription,
                );
                if (
                    (scenario.summary && scenarioNode?.text === scenario.summary) ||
                    (scenario.startDescription && startNode)
                ) {
                    return true;
                }
            } catch (_) {
                // A just-launched bridge can need one discovery cycle.
            }
            await sleep(100);
        }
        return false;
    }

    async dismissKnownDialog() {
        try {
            const tree = await this.command(
                "tree",
                { compact: true, visibleOnly: true, maxNodes: 100 },
                "setup-dialog-tree",
            );
            const button = (tree.nodes || []).find(
                (node) => node.windowType === "window" && node.text === "Continue" && node.clickable,
            );
            if (button?.bounds) {
                const point = midpoint(button.bounds);
                await this.command("tap", { tapX: point.x, tapY: point.y }, "setup-dialog-dismiss");
            }
        } catch (_) {
            // No running bridge or no dialog is a valid cleanup state.
        }
    }

    async bestEffortCommand(command, options, surface) {
        try {
            return await this.command(command, options, surface);
        } catch (error) {
            return { ok: false, error: safeError(error) };
        }
    }

    async bestEffortThaw(surface = "thaw") {
        return this.bestEffortCommand("thaw-app", {}, surface);
    }

    async observe({ includeUia = false } = {}) {
        this.metrics.observations += 1;
        const observationNumber = this.metrics.observations;
        const calls = [
            this.command("status", { full: true }, "observation:status"),
            this.command(
                "tree",
                { compact: true, visibleOnly: true, maxNodes: 140 },
                "observation:tree",
            ),
            this.command("events", { limit: 200 }, "observation:events"),
            this.command(
                "network",
                { limit: 100, urlFilter: "/auth/login" },
                "observation:network",
            ),
            this.command("state", { limit: 100 }, "observation:state-filtered"),
            this.command("keyboard-state", {}, "observation:keyboard"),
        ];
        if (includeUia) {
            calls.push(
                this.command(
                    "uia-tree",
                    { compact: true, visibleOnly: true, maxNodes: 140 },
                    "observation:uia-tree",
                ),
            );
        }
        const [status, tree, events, network, state, keyboard, uia] = await Promise.all(calls);
        const observation = deriveObservation({
            status,
            tree,
            events,
            network,
            publicState: publicStateOnly(state),
            keyboard,
            uia,
        });
        this.trace.push({
            kind: "observation",
            number: observationNumber,
            screen: observation.screen,
            dialog: observation.dialog,
            keyboardVisible: observation.keyboardVisible,
            accountLength: observation.form.accountLength,
            passwordLength: observation.form.passwordLength,
            agreementChecked: observation.form.agreementChecked,
            statusDescription: observation.statusDescription,
            runtimeEpoch: observation.target.runtimeEpoch,
        });
        return observation;
    }

    async readTreeForLocalization(surface) {
        this.metrics.observations += 1;
        this.metrics.localizationReads += 1;
        return this.command(
            "tree",
            { compact: true, visibleOnly: true, maxNodes: 140 },
            surface,
        );
    }

    async tapControl(control, actionName) {
        this.metrics.actions += 1;
        if (!control?.bounds) {
            const outcome = { ok: false, reason: "target-missing", target: actionName };
            this.trace.push({ kind: "action", name: actionName, ...outcome });
            return outcome;
        }
        const point = midpoint(control.bounds);
        try {
            const raw = await this.command(
                "tap",
                { tapX: point.x, tapY: point.y, feedback: "auto" },
                `action:${actionName}`,
            );
            const outcome = {
                ok: raw.ok !== false,
                transport: raw.transport,
                handledDown: raw.handledDown,
                handledUp: raw.handledUp,
                targetResourceName: raw.target?.resourceName || null,
            };
            this.trace.push({ kind: "action", name: actionName, ...outcome });
            return outcome;
        } catch (error) {
            const outcome = { ok: false, reason: safeError(error) };
            this.trace.push({ kind: "action", name: actionName, ...outcome });
            return outcome;
        }
    }

    async tapResourceFromObservation(observation, suffix, actionName) {
        return this.tapControl(controlBySuffix(observation, suffix), actionName);
    }

    async tapResourceBySuffix(suffix, actionName) {
        const tree = await this.readTreeForLocalization(`localize:${actionName}`);
        const nodes = dedupeBridgeNodes(tree.nodes || []).map(publicControl);
        const control = nodes.find((node) => suffixMatches(node.resourceName, suffix));
        return this.tapControl(control, actionName);
    }

    async tapTextIfPresent(targetText, actionName) {
        const tree = await this.readTreeForLocalization(`localize:${actionName}`);
        const nodes = dedupeBridgeNodes(tree.nodes || []).map(publicControl);
        const control = nodes.find(
            (node) => node.clickable && String(node.text || "").toLowerCase() === targetText.toLowerCase(),
        );
        if (!control) {
            const outcome = { ok: false, reason: "target-missing", targetText };
            this.trace.push({ kind: "action", name: actionName, ...outcome });
            return outcome;
        }
        return this.tapControl(control, actionName);
    }

    async inputFocused(text, targetSuffix, secret) {
        this.metrics.actions += 1;
        try {
            const raw = await this.command(
                "input-text",
                { text },
                secret ? "action:input-password-result" : "action:input-account-result",
            );
            const targetResourceName = raw.target?.resourceName || null;
            const outcome = {
                ok: raw.ok === true && suffixMatches(targetResourceName, targetSuffix),
                transport: raw.transport,
                focused: raw.focused,
                textLength: Number(raw.textLength ?? text.length),
                targetResourceName,
            };
            this.trace.push({
                kind: "action",
                name: secret ? "input-password" : "input-account",
                ...outcome,
            });
            return outcome;
        } catch (error) {
            const outcome = { ok: false, reason: safeError(error) };
            this.trace.push({
                kind: "action",
                name: secret ? "input-password" : "input-account",
                ...outcome,
            });
            return outcome;
        }
    }

    async inputResourceFromObservation(observation, suffix, text, secret) {
        const focus = await this.tapResourceFromObservation(
            observation,
            suffix,
            secret ? "focus-password" : "focus-account",
        );
        if (!focus.ok) return focus;
        return this.inputFocused(text, suffix, secret);
    }

    async inputResourceBySuffix(suffix, text, secret) {
        const tree = await this.readTreeForLocalization(
            secret ? "localize:password" : "localize:account",
        );
        const controls = dedupeBridgeNodes(tree.nodes || []).map(publicControl);
        const focus = await this.tapControl(
            controls.find((node) => suffixMatches(node.resourceName, suffix)),
            secret ? "focus-password" : "focus-account",
        );
        if (!focus.ok) return focus;
        return this.inputFocused(text, suffix, secret);
    }

    async hideKeyboard() {
        this.metrics.actions += 1;
        try {
            const raw = await this.command("hide-keyboard", { force: true }, "action:hide-keyboard");
            const outcome = { ok: raw.ok !== false, dismissed: raw.dismissed };
            this.trace.push({ kind: "action", name: "hide-keyboard", ...outcome });
            return outcome;
        } catch (error) {
            const outcome = { ok: false, reason: safeError(error) };
            this.trace.push({ kind: "action", name: "hide-keyboard", ...outcome });
            return outcome;
        }
    }

    async semanticWait(milliseconds, reason) {
        this.metrics.actions += 1;
        await sleep(milliseconds);
        this.trace.push({ kind: "action", name: "wait", reason, milliseconds, ok: true });
        return { ok: true };
    }

    async readOracle() {
        if (this.executionActive) {
            throw new Error("intent_fixture.oracle is disabled during execution");
        }
        const capture = await this.command("state", { limit: 100 }, "scoring:oracle");
        const candidates = (capture.items || []).filter(
            (item) => item.namespace === "intent_fixture" && item.key === "oracle",
        );
        return latestById(candidates)?.value || capture.values?.["intent_fixture.oracle"] || null;
    }

    reportMetrics() {
        return {
            ...this.metrics,
            secretLeakSurfaces: [...this.metrics.secretLeakSurfaces].sort(),
            secretLeak: this.metrics.secretLeakOccurrences > 0,
        };
    }
}

function loginIntent() {
    return {
        name: "login",
        target: { ...TARGET },
        inputs: {
            accountRef: "secret://fixture/account",
            passwordRef: "secret://fixture/password-canary",
        },
        success: { authenticated: true, screen: "home" },
        limits: {
            maxLoops: 64,
            timeoutMs: 18_000,
            maxReplans: 64,
        },
        resolveSecret(reference) {
            if (reference === "secret://fixture/account") return ACCOUNT;
            if (reference === "secret://fixture/password-canary") return PASSWORD_CANARY;
            throw new Error(`unknown secret reference: ${reference}`);
        },
    };
}

class StaticKnownBatch {
    async execute(intent, surface) {
        const metrics = baseStrategyMetrics();
        const account = intent.resolveSecret(intent.inputs.accountRef);
        const password = intent.resolveSecret(intent.inputs.passwordRef);
        metrics.loops += 1;
        await surface.tapTextIfPresent("Login", "static-open-login");
        await surface.semanticWait(220, "static-transition-delay");
        await surface.tapTextIfPresent("Continue", "static-dismiss-dialog");
        await surface.inputResourceBySuffix("intent_fixture_account", account, false);
        await surface.inputResourceBySuffix("intent_fixture_password", password, true);
        await surface.tapResourceBySuffix("intent_fixture_terms", "static-toggle-agreement");
        await surface.hideKeyboard();
        const submit = await surface.tapTextIfPresent("Sign in", "static-submit-by-label");
        if (submit.ok) {
            return executionResult("succeeded", "commands-delivered", metrics);
        }
        return executionResult("failed", submit.reason || "submit-not-delivered", metrics);
    }
}

class LoginRecipe {
    async execute(intent, surface) {
        const metrics = baseStrategyMetrics();
        const account = intent.resolveSecret(intent.inputs.accountRef);
        const password = intent.resolveSecret(intent.inputs.passwordRef);
        let runtimeEpoch = null;
        let accountWritten = false;
        let accountVerified = false;
        let passwordWritten = false;
        let passwordVerified = false;
        let agreementVerified = false;
        let keyboardKnownHidden = false;
        let submitted = false;
        const deadline = Date.now() + intent.limits.timeoutMs;

        while (metrics.loops < intent.limits.maxLoops && Date.now() < deadline) {
            metrics.loops += 1;
            const observation = await surface.observe({
                includeUia:
                    accountVerified &&
                    passwordVerified &&
                    !agreementVerified &&
                    keyboardKnownHidden,
            });
            keyboardKnownHidden = !observation.keyboardVisible;
            if (runtimeEpoch === null) runtimeEpoch = observation.target.runtimeEpoch;
            else if (runtimeEpoch !== observation.target.runtimeEpoch) {
                return executionResult("inconclusive", "environment-changed", metrics);
            }

            const terminal = classifyObservation(observation, metrics);
            if (terminal) return terminal;
            if (accountWritten && observation.form.accountLength === account.length) accountVerified = true;
            if (passwordWritten && observation.form.passwordLength === password.length) passwordVerified = true;
            if (observation.form.agreementChecked === true) agreementVerified = true;

            if (submitted) {
                await surface.semanticWait(250, "recipe-await-terminal");
                continue;
            }
            if (observation.dialog) {
                const dialogButton = observation.controls.find(
                    (control) => control.windowType === "window" && control.text === "Continue",
                );
                const action = await surface.tapControl(dialogButton, "recipe-dismiss-dialog");
                if (!action.ok) return executionResult("failed", "dialog-dismiss-failed", metrics);
                continue;
            }
            if (observation.screen === "welcome") {
                const action = await surface.tapResourceFromObservation(
                    observation,
                    "intent_fixture_login_entry",
                    "recipe-open-login",
                );
                if (!action.ok) return executionResult("failed", "login-entry-failed", metrics);
                await surface.semanticWait(220, "recipe-await-login");
                continue;
            }
            if (observation.screen !== "login") {
                return executionResult("failed", "unsupported-screen", metrics);
            }
            if (!observation.form.accountPresent || !observation.form.passwordPresent) {
                return executionResult("failed", "missing-input-control", metrics);
            }
            if (!observation.form.agreementPresent) {
                return executionResult("failed", "missing-required-control", metrics);
            }

            const submitCandidates = unique(
                observation.controls
                    .filter((control) => control.clickable && control.text === "Sign in")
                    .map((control) => control.resourceName),
            );
            if (submitCandidates.length !== 1) {
                return executionResult("failed", "ambiguous-target", metrics);
            }
            if (!accountVerified) {
                const action = await surface.inputResourceFromObservation(
                    observation,
                    "intent_fixture_account",
                    account,
                    false,
                );
                if (!action.ok) return executionResult("failed", "account-input-unverified", metrics);
                accountWritten = true;
                continue;
            }
            if (!passwordVerified) {
                const action = await surface.inputResourceFromObservation(
                    observation,
                    "intent_fixture_password",
                    password,
                    true,
                );
                if (!action.ok) return executionResult("failed", "password-input-unverified", metrics);
                passwordWritten = true;
                continue;
            }
            if (observation.keyboardVisible) {
                const action = await surface.hideKeyboard();
                keyboardKnownHidden = action.ok;
                continue;
            }
            if (observation.form.agreementChecked === null) {
                await surface.semanticWait(120, "recipe-await-agreement-state");
                continue;
            }
            if (!agreementVerified) {
                const action = await surface.tapResourceFromObservation(
                    observation,
                    "intent_fixture_terms",
                    "recipe-accept-terms",
                );
                if (!action.ok) return executionResult("failed", "agreement-action-failed", metrics);
                continue;
            }
            const action = await surface.tapResourceFromObservation(
                observation,
                "intent_fixture_submit",
                "recipe-submit-once",
            );
            if (!action.ok) return executionResult("failed", "submit-not-delivered", metrics);
            submitted = true;
        }
        return executionResult("inconclusive", submitted ? "terminal-not-observed" : "recipe-budget-exhausted", metrics);
    }
}

function planHtn(observation, context, metrics) {
    if (observation.dialog) {
        return {
            name: "clear-obstruction",
            control: observation.controls.find(
                (control) => control.windowType === "window" && control.text === "Continue",
            ),
            kind: "tap-control",
        };
    }
    if (observation.screen === "welcome") {
        return {
            name: "reach-login",
            suffix: "intent_fixture_login_entry",
            kind: "tap-resource",
        };
    }
    if (observation.screen === "unknown") {
        return { name: "observe-transition", kind: "wait-transition" };
    }
    if (observation.screen !== "login") {
        return { terminal: executionResult("failed", "unsupported-screen", metrics) };
    }
    if (!observation.form.accountPresent || !observation.form.passwordPresent) {
        return { terminal: executionResult("failed", "missing-input-control", metrics) };
    }
    if (!observation.form.agreementPresent) {
        return { terminal: executionResult("failed", "missing-required-control", metrics) };
    }
    if (!controlBySuffix(observation, "intent_fixture_submit")) {
        return { terminal: executionResult("failed", "missing-submit-control", metrics) };
    }
    if (!context.accountVerified) {
        return {
            name: "establish-account",
            suffix: "intent_fixture_account",
            value: context.account,
            secret: false,
            kind: "input-resource",
        };
    }
    if (!context.passwordVerified) {
        return {
            name: "establish-password",
            suffix: "intent_fixture_password",
            value: context.password,
            secret: true,
            kind: "input-resource",
        };
    }
    if (observation.keyboardVisible) {
        return { name: "remove-keyboard-obstruction", kind: "hide-keyboard" };
    }
    if (observation.form.agreementChecked === null) {
        return { name: "observe-agreement-state", kind: "wait-agreement" };
    }
    if (!observation.form.agreementChecked) {
        return {
            name: "establish-agreement",
            suffix: "intent_fixture_terms",
            kind: "tap-resource",
        };
    }
    return {
        name: "submit-once",
        suffix: "intent_fixture_submit",
        kind: "tap-resource",
        submit: true,
    };
}

class BoundedHtn {
    async execute(intent, surface) {
        const metrics = baseStrategyMetrics();
        const context = {
            account: intent.resolveSecret(intent.inputs.accountRef),
            password: intent.resolveSecret(intent.inputs.passwordRef),
            accountWritten: false,
            accountVerified: false,
            passwordWritten: false,
            passwordVerified: false,
            runtimeEpoch: null,
            submitted: false,
            priorPlan: null,
            agreementStateMisses: 0,
            transitionStateMisses: 0,
            keyboardKnownHidden: false,
        };
        const deadline = Date.now() + intent.limits.timeoutMs;

        while (
            metrics.loops < intent.limits.maxLoops &&
            metrics.replans <= intent.limits.maxReplans &&
            Date.now() < deadline
        ) {
            metrics.loops += 1;
            const observation = await surface.observe({
                includeUia: !context.submitted && observationNeedsAgreementProbe(context),
            });
            context.keyboardKnownHidden = !observation.keyboardVisible;
            if (context.runtimeEpoch === null) context.runtimeEpoch = observation.target.runtimeEpoch;
            else if (context.runtimeEpoch !== observation.target.runtimeEpoch) {
                if (context.submitted) {
                    return executionResult(
                        "inconclusive",
                        "epoch-changed-after-submit",
                        metrics,
                    );
                }
                context.runtimeEpoch = observation.target.runtimeEpoch;
                context.accountWritten = false;
                context.accountVerified = false;
                context.passwordWritten = false;
                context.passwordVerified = false;
                metrics.replans += 1;
            }

            const terminal = classifyObservation(observation, metrics);
            if (terminal) return terminal;
            if (context.accountWritten && observation.form.accountLength === context.account.length) {
                context.accountVerified = true;
            }
            if (context.passwordWritten && observation.form.passwordLength === context.password.length) {
                context.passwordVerified = true;
            }
            if (context.submitted) {
                await surface.semanticWait(250, "htn-await-terminal");
                continue;
            }

            const plan = planHtn(observation, context, metrics);
            if (plan.terminal) return plan.terminal;
            if (context.priorPlan !== plan.name) {
                metrics.replans += 1;
                context.priorPlan = plan.name;
            }

            let action;
            if (plan.kind === "tap-control") {
                action = await surface.tapControl(plan.control, `htn-${plan.name}`);
            } else if (plan.kind === "tap-resource") {
                action = await surface.tapResourceFromObservation(
                    observation,
                    plan.suffix,
                    `htn-${plan.name}`,
                );
            } else if (plan.kind === "input-resource") {
                action = await surface.inputResourceFromObservation(
                    observation,
                    plan.suffix,
                    plan.value,
                    plan.secret,
                );
            } else if (plan.kind === "hide-keyboard") {
                action = await surface.hideKeyboard();
                context.keyboardKnownHidden = action.ok;
            } else if (plan.kind === "wait-agreement") {
                context.agreementStateMisses += 1;
                if (context.agreementStateMisses > 3) {
                    return executionResult("inconclusive", "agreement-state-unobservable", metrics);
                }
                action = await surface.semanticWait(120, "htn-await-agreement-state");
            } else {
                context.transitionStateMisses += 1;
                if (context.transitionStateMisses > 4) {
                    return executionResult("inconclusive", "transition-state-unobservable", metrics);
                }
                action = await surface.semanticWait(120, "htn-await-transition-state");
            }
            if (!action.ok) {
                metrics.replans += 1;
                await surface.semanticWait(100, `htn-recover-${plan.name}`);
                continue;
            }
            if (plan.name === "establish-account") context.accountWritten = true;
            if (plan.name === "establish-password") context.passwordWritten = true;
            if (plan.submit) context.submitted = true;
        }
        return executionResult(
            "inconclusive",
            context.submitted ? "terminal-not-observed" : "planning-budget-exhausted",
            metrics,
        );
    }
}

function observationNeedsAgreementProbe(context) {
    return context.accountVerified && context.passwordVerified && context.keyboardKnownHidden;
}

function implementation(name) {
    if (name === "static-known-batch") return new StaticKnownBatch();
    if (name === "login-recipe") return new LoginRecipe();
    if (name === "bounded-htn") return new BoundedHtn();
    throw new Error(`unknown implementation: ${name}`);
}

async function execute(intent, implementationName, surface) {
    return implementation(implementationName).execute(intent, surface);
}

async function oracleAfterExecution(surface, scenario, execution) {
    const shouldAwaitTerminal = execution.status === "succeeded" || execution.reason === "terminal-not-observed";
    const deadline = Date.now() + (shouldAwaitTerminal ? scenario.oracleTimeoutMs : 1_000);
    let oracle = null;
    do {
        oracle = await surface.readOracle();
        if (oracle && TERMINAL_ORACLE_REASONS.has(oracle.reason)) return oracle;
        if (!shouldAwaitTerminal) return oracle;
        await sleep(120);
    } while (Date.now() < deadline);
    return oracle;
}

function scoreRun(scenario, execution, oracle) {
    const oracleMatches =
        oracle?.reason === scenario.expected.oracleReason &&
        (scenario.expected.kind === "success" ? oracle.authenticated === true : oracle.authenticated === false);
    const executionMatches =
        scenario.expected.kind === "success"
            ? execution.status === "succeeded"
            : execution.status !== "succeeded" &&
              execution.reason === scenario.expected.executionReason;
    return {
        correct: Boolean(oracleMatches && executionMatches),
        falseSuccess: execution.status === "succeeded" && oracle?.authenticated !== true,
        oracleMatches,
        executionMatches,
    };
}

async function runOne(surface, implementationName, scenario) {
    await surface.prepareScenario(scenario);
    const target = { ...surface.targetIdentity };
    surface.executionActive = true;
    const startedAt = process.hrtime.bigint();
    let execution;
    try {
        execution = await execute(loginIntent(), implementationName, surface);
    } catch (error) {
        execution = executionResult("failed", "bridge-execution-error", baseStrategyMetrics(), {
            error: safeError(error),
        });
    } finally {
        surface.executionActive = false;
    }
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const oracle = await oracleAfterExecution(surface, scenario, execution);
    const score = scoreRun(scenario, execution, oracle);
    const metrics = surface.reportMetrics();
    return {
        implementation: implementationName,
        scenario: scenario.name,
        target,
        durationMs,
        actions: metrics.actions,
        observations: metrics.observations,
        localizationReads: metrics.localizationReads,
        result: {
            status: execution.status,
            reason: execution.reason,
            replans: execution.metrics?.replans ?? 0,
            loops: execution.metrics?.loops ?? 0,
        },
        score,
        oracle: oracle
            ? {
                  screen: oracle.screen,
                  authenticated: oracle.authenticated,
                  outcome: oracle.outcome,
                  reason: oracle.reason,
                  submitCount: oracle.submitCount,
                  agreementToggleCount: oracle.agreementToggleCount,
                  runtimeInstance: oracle.runtimeInstance,
              }
            : null,
        secretLeak: metrics.secretLeak,
        secretLeakOccurrences: metrics.secretLeakOccurrences,
        secretLeakSurfaces: metrics.secretLeakSurfaces,
        trace: surface.trace,
    };
}

function aggregateRuns(runs) {
    return IMPLEMENTATIONS.map((name) => {
        const selected = runs.filter((run) => run.implementation === name);
        return {
            implementation: name,
            runs: selected.length,
            correct: selected.filter((run) => run.score.correct).length,
            falseSuccess: selected.filter((run) => run.score.falseSuccess).length,
            totalActions: selected.reduce((sum, run) => sum + run.actions, 0),
            totalObservations: selected.reduce((sum, run) => sum + run.observations, 0),
            averageDurationMs:
                selected.reduce((sum, run) => sum + run.durationMs, 0) / Math.max(1, selected.length),
            totalSubmitCount: selected.reduce((sum, run) => sum + Number(run.oracle?.submitCount || 0), 0),
            totalToggleCount: selected.reduce(
                (sum, run) => sum + Number(run.oracle?.agreementToggleCount || 0),
                0,
            ),
            secretLeakRuns: selected.filter((run) => run.secretLeak).length,
            secretLeakSurfaces: unique(selected.flatMap((run) => run.secretLeakSurfaces)).sort(),
        };
    });
}

function parseSelection(argv) {
    let scenarioNames = SCENARIOS.map((scenario) => scenario.name);
    let implementationNames = [...IMPLEMENTATIONS];
    for (const argument of argv) {
        if (argument.startsWith("--scenario=")) {
            scenarioNames = argument.slice("--scenario=".length).split(",");
        } else if (argument.startsWith("--implementation=")) {
            implementationNames = argument.slice("--implementation=".length).split(",");
        } else {
            throw new Error(`unknown argument: ${argument}`);
        }
    }
    const scenarios = scenarioNames.map((name) => {
        const scenario = SCENARIOS.find((candidate) => candidate.name === name);
        if (!scenario) throw new Error(`unknown scenario: ${name}`);
        return scenario;
    });
    for (const name of implementationNames) {
        if (!IMPLEMENTATIONS.includes(name)) throw new Error(`unknown implementation: ${name}`);
    }
    return { scenarios, implementationNames };
}

function printTable(runs) {
    const headers = [
        "implementation",
        "scenario",
        "result",
        "oracle",
        "ok",
        "false+",
        "submit",
        "toggle",
        "actions",
        "observations",
        "duration-ms",
        "secret-leak",
    ];
    const rows = runs.map((run) => [
        run.implementation,
        run.scenario,
        `${run.result.status}:${run.result.reason}`,
        run.oracle ? `${run.oracle.screen}:${run.oracle.reason}` : "missing",
        run.score.correct ? "yes" : "no",
        run.score.falseSuccess ? "yes" : "no",
        String(run.oracle?.submitCount ?? "?"),
        String(run.oracle?.agreementToggleCount ?? "?"),
        String(run.actions),
        String(run.observations),
        run.durationMs.toFixed(0),
        run.secretLeak ? "yes" : "no",
    ]);
    const widths = headers.map((header, index) =>
        Math.max(header.length, ...rows.map((row) => row[index].length)),
    );
    const render = (row) => row.map((cell, index) => cell.padEnd(widths[index])).join("  ");
    console.log(render(headers));
    console.log(render(widths.map((width) => "-".repeat(width))));
    for (const row of rows) console.log(render(row));
}

async function main() {
    const selection = parseSelection(process.argv.slice(2));
    const surface = new SurfaceAdapter();
    const runs = [];
    let finalThaw = null;
    let finalStatus = null;
    try {
        for (const implementationName of selection.implementationNames) {
            for (const scenario of selection.scenarios) {
                process.stderr.write(`[bridge fixture] ${implementationName} / ${scenario.name}\n`);
                runs.push(await runOne(surface, implementationName, scenario));
            }
        }
    } finally {
        surface.executionActive = false;
        finalThaw = await surface.bestEffortThaw("final-thaw");
        finalStatus = await surface.bestEffortCommand("status", { full: true }, "final-status");
    }

    const thawResults = Array.isArray(finalThaw?.results) ? finalThaw.results : [];
    const thawConfirmed =
        finalThaw?.ok === true &&
        finalThaw?.signal === "SIGCONT" &&
        thawResults.length > 0 &&
        thawResults.every((result) => result?.ok === true);
    const report = {
        prototype: "THROWAWAY real AI App Bridge intent fixture experiment",
        target: {
            serial: TARGET.serial,
            packageName: TARGET.packageName,
            activity: finalStatus?.activity?.current || TARGET.activity,
            runtimeEpoch: finalStatus?.debugBridge?.runtimeEpoch || null,
            model: finalStatus?.android?.model || null,
        },
        finalAppState: {
            thawOk: thawConfirmed,
            frozen: thawConfirmed ? false : null,
            thawSignal: finalThaw?.signal || null,
            thawPids: Array.isArray(finalThaw?.pids) ? finalThaw.pids : [],
            statusOk: finalStatus?.ok === true,
        },
        aggregate: aggregateRuns(runs),
        runs,
    };
    printTable(runs);
    console.log("");
    console.log(JSON.stringify(report, null, 2));
    if (!report.finalAppState.thawOk || report.finalAppState.frozen !== false) {
        process.exitCode = 2;
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(safeError(error));
        process.exitCode = 1;
    });
}

module.exports = {
    IMPLEMENTATIONS,
    SCENARIOS,
    SurfaceAdapter,
    execute,
    scoreRun,
};
