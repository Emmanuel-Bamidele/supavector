#!/usr/bin/env node
// Grade an existing answer run again with another judge.
//
//   node eval/rejudge.js --judge-model claude-opus-5-5 --label judge-claude \
//     results/v2-k20/multihop-rag--supavector--answer.json [more runs...]
//
// The answers are not regenerated: each row keeps its answer text, and only
// the verdict changes. Each output lands in results/<label>/ as
// <source label>--<file name>, so compare.js pairs runs graded by the same judge. Prints how
// often the two judges agree. Grading costs money per row, so each verdict is
// checkpointed and an interrupted run resumes.

const fs = require("fs");
const path = require("path");
const { createJudge } = require("./lib/judge");
const { summarizeAnswers } = require("./lib/metrics");
const { mapLimit } = require("./lib/http");

const argv = process.argv.slice(2);
const opt = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : null;
};
const judgeModel = opt("judge-model");
const label = opt("label");
const files = argv.filter((a, i) => !a.startsWith("--") && !["--judge-model", "--label"].includes(argv[i - 1]));
if (!judgeModel || !label || !files.length) {
  console.error("usage: node eval/rejudge.js --judge-model <model> --label <out-label> <run.json> [...]");
  process.exit(1);
}

(async () => {
  const judge = createJudge({ model: judgeModel });
  for (const file of files) {
    const run = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(run.answerRows)) throw new Error(`${file} has no answer rows`);
    const outDir = path.join(__dirname, "results", label);
    fs.mkdirSync(outDir, { recursive: true });
    // Prefixed with the source label: runs of one system share a file name.
    const outFile = path.join(outDir, `${run.label}--${path.basename(file)}`);
    const checkpoint = `${outFile}.partial.jsonl`;
    const done = new Map(fs.existsSync(checkpoint)
      ? fs.readFileSync(checkpoint, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
        .filter((r) => !/^judge error/.test(r.judgeReason || "")).map((r) => [r.id, r])
      : []);
    const rows = await mapLimit(run.answerRows, 4, async (row) => {
      if (done.has(row.id)) return done.get(row.id);
      if (row.reference === null || row.reference === undefined) return { ...row, primaryCorrect: row.correct };
      const grade = await judge.grade({ question: row.question, reference: String(row.reference), candidate: row.answer })
        .catch((err) => ({ correct: false, abstained: false, reason: `judge error: ${err.message}` }));
      const out = { ...row, primaryCorrect: row.correct, correct: grade.correct, abstained: grade.abstained, judgeReason: grade.reason };
      // A failed grade is not a verdict: it is reported, never resumed from.
      if (!/^judge error/.test(grade.reason)) fs.appendFileSync(checkpoint, `${JSON.stringify(out)}\n`);
      return out;
    });
    const failed = rows.filter((r) => /^judge error/.test(r.judgeReason || ""));
    if (failed.length) {
      // A failed grade is not a verdict. Keep the checkpoint and stop here.
      console.error(`${run.system} (${run.label}): ${failed.length} grades failed, e.g. ${failed[0].judgeReason.slice(0, 200)}. Progress saved; rerun to finish.`);
      process.exitCode = 1;
      continue;
    }
    const graded = rows.filter((r) => r.primaryCorrect !== null && r.primaryCorrect !== undefined);
    const agree = graded.filter((r) => r.correct === r.primaryCorrect).length;
    const result = {
      ...run,
      label,
      judgeModel: judge.model,
      primaryJudgeModel: run.judgeModel,
      judgeAgreement: graded.length ? agree / graded.length : null,
      answers: summarizeAnswers(rows),
      answerRows: rows
    };
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
    if (fs.existsSync(checkpoint)) fs.unlinkSync(checkpoint);
    console.log(`${run.system} (${run.label}): ${(result.answers.accuracy * 100).toFixed(1)}% by ${judge.model} vs ${(run.answers.accuracy * 100).toFixed(1)}% by ${run.judgeModel}; judges agree on ${agree}/${graded.length}; errors ${rows.filter((r) => /judge error/.test(r.judgeReason || "")).length} -> ${outFile}`);
  }
})().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
