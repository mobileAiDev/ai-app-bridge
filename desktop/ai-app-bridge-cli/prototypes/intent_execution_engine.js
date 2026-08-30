(function loadIntentPrototype(root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    } else {
        root.IntentExecutionPrototype = api;
    }
})(typeof globalThis === "object" ? globalThis : this, function createIntentPrototype() {
    "use strict";

    const IMPLEMENTATIONS = ["static-batch", "login-recipe", "bounded-htn"];
    const SCENARIOS = [
        "already-authenticated",
        "home-to-login",
        "empty-form",
        "prefilled-account",
        "agreement-checked",
        "wrong-password",
        "agreement-missing",
        "network-failure",
        "network-timeout",
        "otp-required",
        "captcha-required",
        "ambiguous-submit-delivery",
        "dialog-keyboard-animation",
        "runtime-epoch-change",
        "duplicate-labels",
    ];

    const CORRECT_ACCOUNT = "operator@example.test";
    const CORRECT_PASSWORD = "correct-pass";

    function nowMilliseconds() {
        if (typeof performance === "object" && typeof performance.now === "function") {
            return performance.now();
        }
        return Date.now();
    }

    function hashText(value) {
        let hash = 2166136261;
        for (let index = 0; index < value.length; index += 1) {
            hash ^= value.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(16).padStart(8, "0");
    }

    function createRng(seed) {
        let state = seed >>> 0;
        return function random() {
            state += 0x6d2b79f5;
            let value = state;
            value = Math.imul(value ^ (value >>> 15), value | 1);
            value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
            return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
        };
    }

    function scenarioDefinition(name) {
        if (!SCENARIOS.includes(name)) {
            throw new Error(`Unknown scenario: ${name}`);
        }

        const definition = {
            name,
            startScreen: "login",
            authenticated: false,
            account: "",
            password: "",
            agreementChecked: false,
            agreementPresent: true,
            networkMode: "ok",
            postSubmit: "dashboard",
            dialog: null,
            keyboard: false,
            animationFrames: 0,
            duplicateLabels: false,
            runtimeEpochChangeAtAction: null,
            intentPassword: CORRECT_PASSWORD,
        };

        if (name === "already-authenticated") {
            definition.startScreen = "dashboard";
            definition.authenticated = true;
        } else if (name === "home-to-login") {
            definition.startScreen = "home";
            definition.animationFramesAfterNavigation = 1;
        } else if (name === "prefilled-account") {
            definition.account = CORRECT_ACCOUNT;
        } else if (name === "agreement-checked") {
            definition.agreementChecked = true;
        } else if (name === "wrong-password") {
            definition.intentPassword = "wrong-pass";
        } else if (name === "agreement-missing") {
            definition.agreementPresent = false;
        } else if (name === "network-failure") {
            definition.networkMode = "failure";
        } else if (name === "network-timeout") {
            definition.networkMode = "timeout";
        } else if (name === "otp-required") {
            definition.postSubmit = "otp";
        } else if (name === "captcha-required") {
            definition.postSubmit = "captcha";
        } else if (name === "ambiguous-submit-delivery") {
            definition.networkMode = "ambiguous-applied";
        } else if (name === "dialog-keyboard-animation") {
            definition.dialog = "marketing-dialog";
            definition.keyboard = true;
            definition.animationFrames = 3;
        } else if (name === "runtime-epoch-change") {
            definition.startScreen = "home";
            definition.animationFramesAfterNavigation = 1;
            definition.runtimeEpochChangeAtAction = 4;
        } else if (name === "duplicate-labels") {
            definition.duplicateLabels = true;
        }

        return definition;
    }

    function createIntent(scenarioName) {
        const scenario = scenarioDefinition(scenarioName);
        return {
            name: "login",
            target: {
                deviceId: "prototype-device-01",
                appId: "example.login.fixture",
                runtimeEpoch: null,
            },
            inputs: {
                accountRef: "secret://login/account",
                passwordRef: `secret://login/password/${scenarioName}`,
            },
            success: {
                authenticated: true,
                screen: "dashboard",
            },
            limits: {
                maxActions: 48,
                maxObservations: 96,
                maxReplans: 48,
                maxEpochRestarts: 1,
            },
            resolveSecret(reference) {
                if (reference === "secret://login/account") {
                    return CORRECT_ACCOUNT;
                }
                if (reference === `secret://login/password/${scenarioName}`) {
                    return scenario.intentPassword;
                }
                throw new Error(`Unknown prototype secret reference: ${reference}`);
            },
        };
    }

    function createControls(state, definition) {
        if (state.screen === "home") {
            return [
                { id: "home.login", role: "button", semantic: "open-login", label: "登录" },
            ];
        }
        if (state.screen !== "login") {
            return [];
        }

        const controls = [
            { id: "login.account", role: "textbox", semantic: "account", label: "账号" },
            { id: "login.password", role: "textbox", semantic: "password", label: "密码" },
        ];
        if (definition.agreementPresent) {
            controls.push({
                id: "login.agreement",
                role: "checkbox",
                semantic: "agreement",
                label: "同意协议",
            });
        }
        if (definition.duplicateLabels) {
            controls.push({
                id: "login.promo-login",
                role: "button",
                semantic: "login",
                label: "登录",
                container: "promo-card",
            });
        }
        controls.push({
            id: "login.submit.primary",
            role: "button",
            semantic: "login",
            label: "登录",
            container: "credential-form",
        });
        return controls;
    }

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    class SimulatedLoginApp {
        constructor(scenarioName, options = {}) {
            this.definition = scenarioDefinition(scenarioName);
            this.random = createRng(options.seed ?? 1);
            this.noise = options.noise === true;
            this.noiseProfile = {
                staleObservationProbability: options.staleObservationProbability ?? 0.12,
                transientActionBlockProbability: options.transientActionBlockProbability ?? 0.08,
            };
            this.state = {
                runtimeEpoch: 1,
                uiVersion: 1,
                screen: this.definition.startScreen,
                authenticated: this.definition.authenticated,
                account: this.definition.account,
                password: this.definition.password,
                agreementChecked: this.definition.agreementChecked,
                focus: null,
                keyboard: this.definition.keyboard,
                dialog: this.definition.dialog,
                animationFrames: this.definition.animationFrames,
                error: null,
            };
            this.metrics = {
                actions: 0,
                observations: 0,
                unsafeDuplicateSubmit: 0,
                unsafeDuplicateToggle: 0,
                wrongTargetActions: 0,
                transientBlocks: 0,
                staleObservations: 0,
            };
            this.trace = [];
            this.submitCount = 0;
            this.deliveredToggleCount = 0;
            this.lastObservation = null;
            this.runtimeEpochChangeConsumed = false;
        }

        redactedState() {
            return {
                scenario: this.definition.name,
                runtimeEpoch: this.state.runtimeEpoch,
                uiVersion: this.state.uiVersion,
                screen: this.state.screen,
                authenticated: this.state.authenticated,
                form: {
                    accountLength: this.state.account.length,
                    accountFingerprint: hashText(this.state.account),
                    passwordLength: this.state.password.length,
                    agreementChecked: this.state.agreementChecked,
                    agreementPresent: this.definition.agreementPresent,
                },
                focus: this.state.focus,
                keyboard: this.state.keyboard,
                dialog: this.state.dialog,
                animationFrames: this.state.animationFrames,
                error: this.state.error,
                duplicateLabels: this.definition.duplicateLabels,
                networkMode: this.definition.networkMode,
                submitCount: this.submitCount,
            };
        }

        observe() {
            this.metrics.observations += 1;
            const current = {
                observationId: this.metrics.observations,
                runtimeEpoch: this.state.runtimeEpoch,
                uiVersion: this.state.uiVersion,
                screen: this.state.screen,
                authenticated: this.state.authenticated,
                form: {
                    accountLength: this.state.account.length,
                    accountFingerprint: hashText(this.state.account),
                    passwordLength: this.state.password.length,
                    agreementChecked: this.state.agreementChecked,
                },
                focus: this.state.focus,
                keyboard: this.state.keyboard,
                dialog: this.state.dialog,
                animation: this.state.animationFrames > 0,
                error: this.state.error,
                controls: createControls(this.state, this.definition),
                stale: false,
            };

            let observation = current;
            if (
                this.noise &&
                this.lastObservation &&
                this.random() < this.noiseProfile.staleObservationProbability
            ) {
                observation = { ...clone(this.lastObservation), stale: true };
                this.metrics.staleObservations += 1;
            } else {
                this.lastObservation = current;
            }

            this.trace.push({
                kind: "observation",
                id: observation.observationId,
                epoch: observation.runtimeEpoch,
                uiVersion: observation.uiVersion,
                screen: observation.screen,
                authenticated: observation.authenticated,
                error: observation.error,
                stale: observation.stale,
            });

            if (this.state.animationFrames > 0) {
                this.state.animationFrames -= 1;
                this.state.uiVersion += 1;
            }
            return observation;
        }

        perform(action) {
            this.metrics.actions += 1;
            const actionNumber = this.metrics.actions;
            let result;

            if (this.shouldTransientlyBlock(action)) {
                this.metrics.transientBlocks += 1;
                result = this.actionResult("no", false, "transient-input-block");
            } else {
                result = this.applyAction(action);
            }

            this.maybeChangeRuntimeEpoch(actionNumber);
            this.trace.push({
                kind: "action",
                number: actionNumber,
                type: action.type,
                target: action.target ?? null,
                delivered: result.delivered,
                changed: result.changed,
                reason: result.reason ?? null,
            });
            return result;
        }

        shouldTransientlyBlock(action) {
            if (!this.noise) {
                return false;
            }
            const blockable = new Set([
                "navigate-login",
                "wait-stable",
                "dismiss-dialog",
                "focus",
                "replace-text",
                "toggle-agreement",
                "hide-keyboard",
            ]);
            return (
                blockable.has(action.type) &&
                this.random() < this.noiseProfile.transientActionBlockProbability
            );
        }

        actionResult(delivered, changed, reason, extra = {}) {
            return { delivered, changed, reason: reason ?? null, ...extra };
        }

        applyAction(action) {
            if (action.type === "navigate-login") {
                if (this.state.authenticated) {
                    return this.actionResult("no", false, "already-authenticated");
                }
                if (this.state.screen === "login") {
                    return this.actionResult("yes", false, "already-on-login");
                }
                if (this.state.screen !== "home") {
                    return this.actionResult("no", false, "open-login-control-missing");
                }
                this.state.screen = "login";
                this.state.animationFrames = this.definition.animationFramesAfterNavigation ?? 0;
                this.markChanged();
                return this.actionResult("yes", true);
            }

            if (action.type === "wait-stable") {
                const changed = this.state.animationFrames > 0;
                this.state.animationFrames = 0;
                if (changed) {
                    this.markChanged();
                }
                return this.actionResult("yes", changed);
            }

            if (action.type === "dismiss-dialog") {
                if (!this.state.dialog) {
                    return this.actionResult("no", false, "dialog-missing");
                }
                this.state.dialog = null;
                this.markChanged();
                return this.actionResult("yes", true);
            }

            if (this.state.dialog || this.state.animationFrames > 0) {
                return this.actionResult("yes", false, this.state.dialog ? "intercepted-by-dialog" : "animation-busy");
            }

            if (action.type === "focus") {
                if (this.state.screen !== "login" || !["account", "password"].includes(action.target)) {
                    return this.actionResult("no", false, "field-missing");
                }
                this.state.focus = action.target;
                this.state.keyboard = true;
                this.markChanged();
                return this.actionResult("yes", true);
            }

            if (action.type === "replace-text") {
                if (this.state.screen !== "login" || this.state.focus !== action.target) {
                    return this.actionResult("no", false, "focus-required");
                }
                if (!["account", "password"].includes(action.target)) {
                    return this.actionResult("no", false, "field-missing");
                }
                this.state[action.target] = action.value;
                this.state.error = null;
                this.markChanged();
                return this.actionResult("yes", true);
            }

            if (action.type === "toggle-agreement") {
                if (this.state.screen !== "login" || !this.definition.agreementPresent) {
                    return this.actionResult("no", false, "agreement-control-missing");
                }
                this.deliveredToggleCount += 1;
                if (this.state.agreementChecked) {
                    this.metrics.unsafeDuplicateToggle += 1;
                }
                this.state.agreementChecked = !this.state.agreementChecked;
                this.markChanged();
                return this.actionResult("yes", true);
            }

            if (action.type === "hide-keyboard") {
                const changed = this.state.keyboard || this.state.focus !== null;
                this.state.keyboard = false;
                this.state.focus = null;
                if (changed) {
                    this.markChanged();
                }
                return this.actionResult("yes", changed);
            }

            if (action.type === "submit") {
                return this.submit(action.target);
            }

            return this.actionResult("no", false, "unknown-action");
        }

        submit(target) {
            if (this.submitCount > 0 || this.state.authenticated) {
                this.metrics.unsafeDuplicateSubmit += 1;
            }
            if (this.state.screen !== "login") {
                this.submitCount += 1;
                return this.actionResult("no", false, "submit-control-missing");
            }

            const candidates = createControls(this.state, this.definition).filter(
                (control) => control.role === "button" && control.label === "登录",
            );
            let resolvedTarget = target;
            if (target === "text:登录") {
                resolvedTarget = candidates[0]?.id;
            }
            if (resolvedTarget === "login.promo-login") {
                this.metrics.wrongTargetActions += 1;
                this.markChanged();
                return this.actionResult("yes", true, "opened-promo-card");
            }
            if (resolvedTarget !== "login.submit.primary") {
                return this.actionResult("no", false, "submit-target-missing");
            }

            this.submitCount += 1;
            if (!this.state.account || !this.state.password) {
                this.state.error = "missing-fields";
                this.markChanged();
                return this.actionResult("yes", true, "business-rejected");
            }
            if (!this.definition.agreementPresent) {
                this.state.error = "agreement-control-missing";
                this.markChanged();
                return this.actionResult("yes", true, "business-rejected");
            }
            if (!this.state.agreementChecked) {
                this.state.error = "agreement-required";
                this.markChanged();
                return this.actionResult("yes", true, "business-rejected");
            }
            if (this.definition.networkMode === "failure") {
                this.state.error = "network-error";
                this.markChanged();
                return this.actionResult("yes", true, "request-failed");
            }
            if (this.definition.networkMode === "timeout") {
                this.state.error = "network-timeout";
                this.markChanged();
                return this.actionResult("unknown", true, "transport-timeout");
            }
            if (this.state.account !== CORRECT_ACCOUNT || this.state.password !== CORRECT_PASSWORD) {
                this.state.error = "invalid-credentials";
                this.markChanged();
                return this.actionResult("yes", true, "business-rejected");
            }

            if (this.definition.postSubmit === "otp") {
                this.state.screen = "otp";
                this.state.keyboard = false;
                this.state.focus = null;
                this.markChanged();
                return this.actionResult("yes", true);
            }
            if (this.definition.postSubmit === "captcha") {
                this.state.screen = "captcha";
                this.state.keyboard = false;
                this.state.focus = null;
                this.markChanged();
                return this.actionResult("yes", true);
            }

            this.state.authenticated = true;
            this.state.screen = "dashboard";
            this.state.error = null;
            this.state.keyboard = false;
            this.state.focus = null;
            this.markChanged();
            if (this.definition.networkMode === "ambiguous-applied") {
                return this.actionResult("unknown", true, "response-lost-after-commit");
            }
            return this.actionResult("yes", true);
        }

        maybeChangeRuntimeEpoch(actionNumber) {
            if (
                this.runtimeEpochChangeConsumed ||
                this.definition.runtimeEpochChangeAtAction !== actionNumber
            ) {
                return;
            }
            this.runtimeEpochChangeConsumed = true;
            this.state.runtimeEpoch += 1;
            this.state.uiVersion += 1;
            this.state.screen = "home";
            this.state.authenticated = false;
            this.state.account = "";
            this.state.password = "";
            this.state.agreementChecked = false;
            this.state.focus = null;
            this.state.keyboard = false;
            this.state.dialog = null;
            this.state.animationFrames = 0;
            this.state.error = null;
            this.lastObservation = null;
            this.trace.push({
                kind: "runtime",
                event: "epoch-changed",
                runtimeEpoch: this.state.runtimeEpoch,
            });
        }

        markChanged() {
            this.state.uiVersion += 1;
        }
    }

    function baseExecutionMetrics() {
        return {
            replans: 0,
            decisionMilliseconds: 0,
            iterations: 0,
        };
    }

    function decide(metrics, callback) {
        const startedAt = nowMilliseconds();
        const value = callback();
        metrics.decisionMilliseconds += nowMilliseconds() - startedAt;
        return value;
    }

    function result(status, reason, metrics, extra = {}) {
        return {
            status,
            reason,
            metrics,
            ...extra,
        };
    }

    function classifyTerminalObservation(observation, metrics) {
        if (observation.authenticated && observation.screen === "dashboard") {
            return result("succeeded", "goal-observed", metrics);
        }
        if (observation.screen === "otp") {
            return result("blocked", "needs-user:otp", metrics);
        }
        if (observation.screen === "captcha") {
            return result("blocked", "needs-user:captcha", metrics);
        }
        const errorReasons = {
            "invalid-credentials": "invalid-credentials",
            "agreement-control-missing": "missing-required-control",
            "network-error": "network-error",
            "network-timeout": "network-timeout",
        };
        if (errorReasons[observation.error]) {
            return result("failed", errorReasons[observation.error], metrics);
        }
        return null;
    }

    class StaticBatchImplementation {
        execute(intent, environment) {
            const metrics = baseExecutionMetrics();
            const account = intent.resolveSecret(intent.inputs.accountRef);
            const password = intent.resolveSecret(intent.inputs.passwordRef);
            const actions = [
                { type: "navigate-login" },
                { type: "wait-stable" },
                { type: "focus", target: "account" },
                { type: "replace-text", target: "account", value: account },
                { type: "focus", target: "password" },
                { type: "replace-text", target: "password", value: password },
                { type: "toggle-agreement" },
                { type: "hide-keyboard" },
                { type: "submit", target: "text:登录" },
            ];

            let lastActionResult = null;
            for (const action of actions) {
                metrics.iterations += 1;
                const selectedAction = decide(metrics, () => action);
                lastActionResult = environment.perform(selectedAction);
            }
            if (lastActionResult?.delivered === "unknown") {
                metrics.iterations += 1;
                const retry = decide(metrics, () => ({ type: "submit", target: "text:登录" }));
                lastActionResult = environment.perform(retry);
            }
            environment.observe();

            if (lastActionResult?.delivered === "yes") {
                return result("succeeded", "commands-delivered", metrics);
            }
            if (lastActionResult?.delivered === "unknown") {
                return result("inconclusive", "transport-unknown", metrics);
            }
            return result("failed", lastActionResult?.reason ?? "action-failed", metrics);
        }
    }

    function findRecipeSubmitCandidates(observation) {
        return observation.controls.filter(
            (control) => control.role === "button" && control.label === "登录",
        );
    }

    class LoginRecipeImplementation {
        execute(intent, environment) {
            const metrics = baseExecutionMetrics();
            const account = intent.resolveSecret(intent.inputs.accountRef);
            const password = intent.resolveSecret(intent.inputs.passwordRef);
            const accountFingerprint = hashText(account);
            let lockedEpoch = null;
            let pendingPasswordProof = false;
            let passwordVerified = false;
            let pendingSubmit = false;
            let pendingSubmitObservations = 0;

            while (
                metrics.iterations < intent.limits.maxActions + intent.limits.maxObservations &&
                environment.metrics.actions < intent.limits.maxActions &&
                environment.metrics.observations < intent.limits.maxObservations
            ) {
                metrics.iterations += 1;
                const observation = environment.observe();
                if (observation.stale) {
                    continue;
                }
                const decision = decide(metrics, () => {
                    if (lockedEpoch === null) {
                        lockedEpoch = observation.runtimeEpoch;
                    } else if (lockedEpoch !== observation.runtimeEpoch) {
                        return { done: result("inconclusive", "environment-changed", metrics) };
                    }

                    const terminal = classifyTerminalObservation(observation, metrics);
                    if (terminal) {
                        return { done: terminal };
                    }
                    if (pendingPasswordProof && observation.form.passwordLength === password.length) {
                        passwordVerified = true;
                        pendingPasswordProof = false;
                    }
                    if (pendingSubmit) {
                        pendingSubmitObservations += 1;
                        if (pendingSubmitObservations >= 4) {
                            return { done: result("inconclusive", "submit-delivery-unresolved", metrics) };
                        }
                        return { action: { type: "wait-stable" } };
                    }
                    if (observation.dialog) {
                        return { action: { type: "dismiss-dialog" } };
                    }
                    if (observation.animation) {
                        return { action: { type: "wait-stable" } };
                    }
                    if (observation.screen === "home") {
                        return { action: { type: "navigate-login" } };
                    }
                    if (observation.screen !== "login") {
                        return { done: result("failed", "unsupported-screen", metrics) };
                    }

                    const agreement = observation.controls.find(
                        (control) => control.semantic === "agreement",
                    );
                    if (!agreement) {
                        return { done: result("failed", "missing-required-control", metrics) };
                    }
                    const submitCandidates = findRecipeSubmitCandidates(observation);
                    if (submitCandidates.length !== 1) {
                        return { done: result("failed", "ambiguous-target", metrics) };
                    }
                    if (observation.form.accountFingerprint !== accountFingerprint) {
                        if (observation.focus !== "account") {
                            return { action: { type: "focus", target: "account" } };
                        }
                        return {
                            action: { type: "replace-text", target: "account", value: account },
                        };
                    }
                    if (!passwordVerified) {
                        if (observation.focus !== "password") {
                            return { action: { type: "focus", target: "password" } };
                        }
                        return {
                            action: { type: "replace-text", target: "password", value: password },
                            expectsPasswordProof: true,
                        };
                    }
                    if (!observation.form.agreementChecked) {
                        return { action: { type: "toggle-agreement" } };
                    }
                    if (observation.keyboard) {
                        return { action: { type: "hide-keyboard" } };
                    }
                    return {
                        action: { type: "submit", target: submitCandidates[0].id },
                        isSubmit: true,
                    };
                });

                if (decision.done) {
                    return decision.done;
                }
                const actionResult = environment.perform(decision.action);
                if (decision.expectsPasswordProof && actionResult.changed) {
                    pendingPasswordProof = true;
                }
                if (decision.isSubmit && actionResult.delivered === "unknown") {
                    pendingSubmit = true;
                }
            }
            return result("inconclusive", "recipe-budget-exhausted", metrics);
        }
    }

    function exactControl(observation, id) {
        return observation.controls.find((control) => control.id === id) ?? null;
    }

    function buildHtnPlan(observation, context) {
        if (observation.dialog) {
            return { name: "clear-dialog", action: { type: "dismiss-dialog" } };
        }
        if (observation.animation) {
            return { name: "reach-stable-ui", action: { type: "wait-stable" } };
        }
        if (observation.screen === "home") {
            return { name: "reach-login-screen", action: { type: "navigate-login" } };
        }
        if (observation.screen !== "login") {
            return { terminal: result("failed", "unsupported-screen", context.metrics) };
        }
        if (!exactControl(observation, "login.account")) {
            return { terminal: result("failed", "missing-account-control", context.metrics) };
        }
        if (!exactControl(observation, "login.password")) {
            return { terminal: result("failed", "missing-password-control", context.metrics) };
        }
        if (!exactControl(observation, "login.agreement")) {
            return { terminal: result("failed", "missing-required-control", context.metrics) };
        }
        if (!exactControl(observation, "login.submit.primary")) {
            return { terminal: result("failed", "missing-submit-control", context.metrics) };
        }
        if (observation.form.accountFingerprint !== context.accountFingerprint) {
            if (observation.focus !== "account") {
                return {
                    name: "focus-account",
                    action: { type: "focus", target: "account" },
                };
            }
            return {
                name: "write-account",
                action: { type: "replace-text", target: "account", value: context.account },
            };
        }
        if (!context.passwordVerified) {
            if (observation.focus !== "password") {
                return {
                    name: "focus-password",
                    action: { type: "focus", target: "password" },
                };
            }
            return {
                name: "write-password",
                action: { type: "replace-text", target: "password", value: context.password },
                provesPassword: true,
            };
        }
        if (!observation.form.agreementChecked) {
            return { name: "ensure-agreement", action: { type: "toggle-agreement" } };
        }
        if (observation.keyboard) {
            return { name: "clear-input-obstruction", action: { type: "hide-keyboard" } };
        }
        return {
            name: "submit-once",
            action: { type: "submit", target: "login.submit.primary" },
            isSubmit: true,
        };
    }

    class BoundedHtnImplementation {
        execute(intent, environment) {
            const metrics = baseExecutionMetrics();
            const account = intent.resolveSecret(intent.inputs.accountRef);
            const password = intent.resolveSecret(intent.inputs.passwordRef);
            const context = {
                metrics,
                account,
                password,
                accountFingerprint: hashText(account),
                runtimeEpoch: null,
                epochRestarts: 0,
                passwordProofPending: false,
                passwordVerified: false,
                submitPending: false,
                submitPendingObservations: 0,
                priorPlanName: null,
            };

            while (
                environment.metrics.actions < intent.limits.maxActions &&
                environment.metrics.observations < intent.limits.maxObservations &&
                metrics.replans <= intent.limits.maxReplans
            ) {
                metrics.iterations += 1;
                const observation = environment.observe();
                if (observation.stale) {
                    continue;
                }

                const decision = decide(metrics, () => {
                    if (context.runtimeEpoch === null) {
                        context.runtimeEpoch = observation.runtimeEpoch;
                    } else if (context.runtimeEpoch !== observation.runtimeEpoch) {
                        if (context.submitPending) {
                            return {
                                terminal: result(
                                    "inconclusive",
                                    "epoch-changed-after-ambiguous-submit",
                                    metrics,
                                ),
                            };
                        }
                        if (context.epochRestarts >= intent.limits.maxEpochRestarts) {
                            return { terminal: result("inconclusive", "environment-changed", metrics) };
                        }
                        context.epochRestarts += 1;
                        context.runtimeEpoch = observation.runtimeEpoch;
                        context.passwordProofPending = false;
                        context.passwordVerified = false;
                        context.priorPlanName = null;
                        metrics.replans += 1;
                    }

                    const terminal = classifyTerminalObservation(observation, metrics);
                    if (terminal) {
                        return { terminal };
                    }
                    if (
                        context.passwordProofPending &&
                        observation.form.passwordLength === context.password.length
                    ) {
                        context.passwordProofPending = false;
                        context.passwordVerified = true;
                    }
                    if (context.submitPending) {
                        context.submitPendingObservations += 1;
                        if (context.submitPendingObservations >= 5) {
                            return {
                                terminal: result("inconclusive", "submit-delivery-unresolved", metrics),
                            };
                        }
                        return {
                            plan: { name: "observe-ambiguous-submit", action: { type: "wait-stable" } },
                        };
                    }
                    return { plan: buildHtnPlan(observation, context) };
                });

                if (decision.terminal) {
                    return decision.terminal;
                }
                if (decision.plan.terminal) {
                    return decision.plan.terminal;
                }
                if (context.priorPlanName !== decision.plan.name) {
                    metrics.replans += 1;
                    context.priorPlanName = decision.plan.name;
                }
                const actionResult = environment.perform(decision.plan.action);
                if (decision.plan.provesPassword && actionResult.changed) {
                    context.passwordProofPending = true;
                }
                if (decision.plan.isSubmit && actionResult.delivered === "unknown") {
                    context.submitPending = true;
                }
            }
            return result("inconclusive", "planning-budget-exhausted", metrics);
        }
    }

    function createImplementation(name) {
        if (name === "static-batch") {
            return new StaticBatchImplementation();
        }
        if (name === "login-recipe") {
            return new LoginRecipeImplementation();
        }
        if (name === "bounded-htn") {
            return new BoundedHtnImplementation();
        }
        throw new Error(`Unknown implementation: ${name}`);
    }

    function execute(implementationName, intent, environment) {
        return createImplementation(implementationName).execute(intent, environment);
    }

    function runSingle(implementationName, scenarioName, options = {}) {
        const environment = new SimulatedLoginApp(scenarioName, options);
        const intent = createIntent(scenarioName);
        const execution = execute(implementationName, intent, environment);
        return {
            implementation: implementationName,
            scenario: scenarioName,
            execution,
            finalState: environment.redactedState(),
            environmentMetrics: { ...environment.metrics },
            trace: environment.trace,
        };
    }

    return {
        IMPLEMENTATIONS,
        SCENARIOS,
        CORRECT_ACCOUNT,
        CORRECT_PASSWORD,
        SimulatedLoginApp,
        createIntent,
        createImplementation,
        execute,
        hashText,
        runSingle,
        scenarioDefinition,
    };
});
