#!/usr/bin/env node
"use strict";

// Independent experiment oracle: this file intentionally does not consume any
// expected outcome exported by the engine under test.
const prototype = require("./intent_execution_engine.js");

const BASE_SEED = 0x51a7e11;
const DEFAULT_ROUNDS = 32;
const EXPECTED = Object.freeze({
    "already-authenticated": { kind: "success" },
    "home-to-login": { kind: "success" },
    "empty-form": { kind: "success" },
    "prefilled-account": { kind: "success" },
    "agreement-checked": { kind: "success" },
    "wrong-password": { kind: "failure", reason: "invalid-credentials" },
    "agreement-missing": { kind: "failure", reason: "missing-required-control" },
    "network-failure": { kind: "failure", reason: "network-error" },
    "network-timeout": { kind: "failure", reason: "network-timeout" },
    "otp-required": { kind: "failure", reason: "needs-user:otp" },
    "captcha-required": { kind: "failure", reason: "needs-user:captcha" },
    "ambiguous-submit-delivery": { kind: "success" },
    "dialog-keyboard-animation": { kind: "success" },
    "runtime-epoch-change": { kind: "success" },
    "duplicate-labels": { kind: "success" },
});

function parseArguments(argv) {
    const options = { rounds: DEFAULT_ROUNDS, jsonOnly: false };
    for (const argument of argv) {
        if (argument === "--json") {
            options.jsonOnly = true;
        } else if (argument.startsWith("--rounds=")) {
            options.rounds = Number.parseInt(argument.slice("--rounds=".length), 10);
        } else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }
    if (!Number.isInteger(options.rounds) || options.rounds < 2) {
        throw new Error("--rounds must be an integer of at least 2");
    }
    return options;
}

function inspectWithOracle(run) {
    const expected = EXPECTED[run.scenario];
    const goalReached =
        run.finalState.authenticated === true && run.finalState.screen === "dashboard";
    const reportedSuccess = run.execution.status === "succeeded";
    const falseSuccess = reportedSuccess && !goalReached;
    const missedObservedGoal = goalReached && !reportedSuccess;
    const correctFailureClassification =
        expected.kind === "failure" &&
        !reportedSuccess &&
        run.execution.reason === expected.reason;
    const correct =
        expected.kind === "success"
            ? goalReached && reportedSuccess
            : !goalReached && correctFailureClassification;

    return {
        correct,
        expected,
        goalReached,
        falseSuccess,
        missedObservedGoal,
        correctFailureClassification,
    };
}

function percentile(sortedValues, percentileValue) {
    if (sortedValues.length === 0) {
        return 0;
    }
    const index = Math.min(
        sortedValues.length - 1,
        Math.ceil(percentileValue * sortedValues.length) - 1,
    );
    return sortedValues[index];
}

function mean(sum, count) {
    return count === 0 ? 0 : sum / count;
}

function createAggregate(implementation) {
    return {
        implementation,
        runs: 0,
        oracleCorrect: 0,
        falseSuccess: 0,
        missedObservedGoal: 0,
        correctFailureClassification: 0,
        unsafeDuplicateSubmit: 0,
        unsafeDuplicateToggle: 0,
        wrongTargetActions: 0,
        actions: 0,
        observations: 0,
        replans: 0,
        decisionMicroseconds: [],
        scenarios: {},
    };
}

function addRun(aggregate, run, oracle) {
    aggregate.runs += 1;
    aggregate.oracleCorrect += Number(oracle.correct);
    aggregate.falseSuccess += Number(oracle.falseSuccess);
    aggregate.missedObservedGoal += Number(oracle.missedObservedGoal);
    aggregate.correctFailureClassification += Number(oracle.correctFailureClassification);
    aggregate.unsafeDuplicateSubmit += run.environmentMetrics.unsafeDuplicateSubmit;
    aggregate.unsafeDuplicateToggle += run.environmentMetrics.unsafeDuplicateToggle;
    aggregate.wrongTargetActions += run.environmentMetrics.wrongTargetActions;
    aggregate.actions += run.environmentMetrics.actions;
    aggregate.observations += run.environmentMetrics.observations;
    aggregate.replans += run.execution.metrics.replans;
    aggregate.decisionMicroseconds.push(run.execution.metrics.decisionMilliseconds * 1000);

    const scenario = (aggregate.scenarios[run.scenario] ??= {
        runs: 0,
        correct: 0,
        falseSuccess: 0,
        unsafe: 0,
        reasons: {},
    });
    scenario.runs += 1;
    scenario.correct += Number(oracle.correct);
    scenario.falseSuccess += Number(oracle.falseSuccess);
    scenario.unsafe +=
        run.environmentMetrics.unsafeDuplicateSubmit +
        run.environmentMetrics.unsafeDuplicateToggle;
    scenario.reasons[run.execution.reason] = (scenario.reasons[run.execution.reason] ?? 0) + 1;
}

function finishAggregate(aggregate) {
    const decisionTimes = aggregate.decisionMicroseconds.sort((left, right) => left - right);
    return {
        implementation: aggregate.implementation,
        runs: aggregate.runs,
        oracleAccuracy: aggregate.oracleCorrect / aggregate.runs,
        falseSuccess: aggregate.falseSuccess,
        missedObservedGoal: aggregate.missedObservedGoal,
        correctFailureClassification: aggregate.correctFailureClassification,
        unsafeDuplicateSubmit: aggregate.unsafeDuplicateSubmit,
        unsafeDuplicateToggle: aggregate.unsafeDuplicateToggle,
        wrongTargetActions: aggregate.wrongTargetActions,
        averageActions: mean(aggregate.actions, aggregate.runs),
        averageObservations: mean(aggregate.observations, aggregate.runs),
        averageReplans: mean(aggregate.replans, aggregate.runs),
        averageDecisionMicroseconds: mean(
            decisionTimes.reduce((sum, value) => sum + value, 0),
            decisionTimes.length,
        ),
        p95DecisionMicroseconds: percentile(decisionTimes, 0.95),
        scenarios: aggregate.scenarios,
    };
}

function runExperiment(rounds) {
    const aggregates = new Map(
        prototype.IMPLEMENTATIONS.map((implementation) => [
            implementation,
            createAggregate(implementation),
        ]),
    );
    const nominal = [];

    for (const implementation of prototype.IMPLEMENTATIONS) {
        for (const scenario of prototype.SCENARIOS) {
            const nominalRun = prototype.runSingle(implementation, scenario, {
                seed: BASE_SEED,
                noise: false,
            });
            nominal.push({
                implementation,
                scenario,
                execution: nominalRun.execution,
                finalState: nominalRun.finalState,
                oracle: inspectWithOracle(nominalRun),
                environmentMetrics: nominalRun.environmentMetrics,
            });

            const scenarioIndex = prototype.SCENARIOS.indexOf(scenario);
            for (let round = 0; round < rounds; round += 1) {
                // The same scenario/round seed is used for all implementations.
                const seed = (BASE_SEED + scenarioIndex * 1009 + round * 9176) >>> 0;
                const run = prototype.runSingle(implementation, scenario, {
                    seed,
                    noise: true,
                });
                addRun(aggregates.get(implementation), run, inspectWithOracle(run));
            }
        }
    }

    return {
        prototype: "THROWAWAY intent execution comparison",
        baseSeed: BASE_SEED,
        noisyRoundsPerScenario: rounds,
        scenarioCount: prototype.SCENARIOS.length,
        implementationCount: prototype.IMPLEMENTATIONS.length,
        totalNoisyRuns: rounds * prototype.SCENARIOS.length * prototype.IMPLEMENTATIONS.length,
        oracleContract: EXPECTED,
        summary: prototype.IMPLEMENTATIONS.map((implementation) =>
            finishAggregate(aggregates.get(implementation)),
        ),
        nominal,
    };
}

function percentage(value) {
    return `${(value * 100).toFixed(1)}%`;
}

function fixed(value, digits = 2) {
    return Number(value).toFixed(digits);
}

function renderSummary(report) {
    const headers = [
        "implementation",
        "oracle",
        "false+",
        "missed goal",
        "unsafe submit",
        "unsafe toggle",
        "actions",
        "observations",
        "replans",
        "decision p95 us",
    ];
    const rows = report.summary.map((summary) => [
        summary.implementation,
        percentage(summary.oracleAccuracy),
        String(summary.falseSuccess),
        String(summary.missedObservedGoal),
        String(summary.unsafeDuplicateSubmit),
        String(summary.unsafeDuplicateToggle),
        fixed(summary.averageActions),
        fixed(summary.averageObservations),
        fixed(summary.averageReplans),
        fixed(summary.p95DecisionMicroseconds),
    ]);
    const widths = headers.map((header, column) =>
        Math.max(header.length, ...rows.map((row) => row[column].length)),
    );
    const renderRow = (row) =>
        row.map((cell, column) => cell.padEnd(widths[column])).join("  ");

    console.log(report.prototype);
    console.log(
        `seed=${report.baseSeed} scenarios=${report.scenarioCount} noisy rounds/scenario=${report.noisyRoundsPerScenario} total=${report.totalNoisyRuns}`,
    );
    console.log("");
    console.log(renderRow(headers));
    console.log(renderRow(widths.map((width) => "-".repeat(width))));
    for (const row of rows) {
        console.log(renderRow(row));
    }
    console.log("");
    console.log("Scenario correctness (correct/runs; ! means false success; U means unsafe repeat):");
    for (const scenario of prototype.SCENARIOS) {
        const cells = report.summary.map((summary) => {
            const value = summary.scenarios[scenario];
            const flags = `${value.falseSuccess > 0 ? "!" : ""}${value.unsafe > 0 ? "U" : ""}`;
            return `${summary.implementation}=${value.correct}/${value.runs}${flags}`;
        });
        console.log(`${scenario.padEnd(28)} ${cells.join("  ")}`);
    }
}

function main() {
    const options = parseArguments(process.argv.slice(2));
    const report = runExperiment(options.rounds);
    if (options.jsonOnly) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        renderSummary(report);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    BASE_SEED,
    EXPECTED,
    inspectWithOracle,
    runExperiment,
};
