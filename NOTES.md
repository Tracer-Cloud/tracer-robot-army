# Prerequisites

Install TypeScript runtime:

```sh
curl -fsSL https://bun.sh/install | bash
```

Create `.env` file in project root and add Anthropic API key:

```sh
ANTHROPIC_API_KEY="XXX"
```

Download NextFlow repositories from `inputs/repositories.txt` to `~/nf-core/*` (`modules` and `rnaseq` repos are the most important).

# Quick start

The current rules and test telemetry are already in the respository, so you can just run `bun src/quality.ts` to inspect `results/004-extract-structured-rules/nextflow-process.json`.

# Generating new rules

Currently each rule generation script takes multiple hours to run

```sh
tmux # run in multiplexer, to run script in background and prevent early interruption
bun run src/001-source-extract.ts
bun run src/002-pattern-generate.ts
bun run src/003-add-descriptions.ts
bun run src/004-extract-structured-rules.ts
```

To test them you first need to gather test telemetry.

First setup eBPF capture:

```sh
cd ~/tracer-client
git checkout feature/ebof-overhaul-phase-2
cd src/ebpf/c && make
./example > ~/tracer-robot-army/inputs/rnaseq-log-nextflow.txt
```

In another terminal, run the pipeline you want to test:

```sh
cd ~/tracer-test-pipelines-bioinformatics/pipelines/nextflow/rnaseq
make test rnaseq
```

It should take about 15 minutes to complete.

Afterwards, extract just the eBPF events we match against:

```sh
cd ~/tracer-robot-army
jq -R 'fromjson? // empty | select(.event_type=="sched/sched_process_exec") | .payload.argv | join(" ")' inputs/rnaseq-log-ebpf.txt > inputs/rnaseq-log-ebpf-extracted-commands.txt
```

Check for issues:

```sh
bun run src/quality.ts
```
