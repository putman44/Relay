import { strict as assert } from 'node:assert';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repositoryRootUrl = new URL('../../', import.meta.url);

async function readRepositoryFile(path: string) {
  return readFile(new URL(path, repositoryRootUrl), 'utf8');
}

test('relay-orchestrate has the canonical explicit-only skill layout', async () => {
  const [skill, openAiConfig] = await Promise.all([
    readRepositoryFile('.agents/skills/relay-orchestrate/SKILL.md'),
    readRepositoryFile('.agents/skills/relay-orchestrate/agents/openai.yaml'),
  ]);
  const claudeSkillPath = fileURLToPath(
    new URL('.claude/skills/relay-orchestrate', repositoryRootUrl),
  );

  assert.match(skill, /^name: relay-orchestrate$/m);
  assert.match(skill, /^disable-model-invocation: true$/m);
  assert.match(openAiConfig, /^  allow_implicit_invocation: false$/m);
  assert.equal((await lstat(claudeSkillPath)).isSymbolicLink(), true);
  assert.equal(await readlink(claudeSkillPath), '../../.agents/skills/relay-orchestrate');
});

test('relay-orchestrate uses one exact, centralized role policy', async () => {
  const [skill, policyText] = await Promise.all([
    readRepositoryFile('.agents/skills/relay-orchestrate/SKILL.md'),
    readRepositoryFile('.agents/relay-orchestration-policy.json'),
  ]);
  const policy = JSON.parse(policyText);

  assert.deepEqual(policy, {
    schemaVersion: 1,
    roles: {
      planner: { model: 'gpt-6.1-sol', reasoningEffort: 'medium' },
      implementer: { model: 'gpt-6.1-sol', reasoningEffort: 'high' },
      reviewer: { model: 'gpt-6.1-sol', reasoningEffort: 'high' },
    },
  });
  assert.match(skill, /\.agents\/relay-orchestration-policy\.json/);
  assert.match(skill, /validate.*schema version.*exactly.*roles/im);
  assert.match(skill, /runtime.*support.*exact.*model.*reasoning effort/is);
  assert.match(skill, /active runtime.*actual host-provided subagent dispatch mechanism/is);
  assert.match(skill, /available subagent spawning interface/i);
  assert.match(skill, /fresh, independent context for each role/i);
  assert.match(skill, /do not assume parameter names or capabilities/i);
  assert.match(
    skill,
    /exact configured model.*reasoning effort.*fresh-context semantics.*cannot be proven.*STOP before mutation/is,
  );
  assert.doesNotMatch(skill, /`spawn_agent`|`fork_turns`|`reasoning_effort`/);
  assert.match(skill, /before any repository mutation/i);
  assert.match(skill, /do not.*fallback|do not.*substitut/i);
  assert.match(skill, /unavailable|unsupported/i);
  assert.match(skill, /STOP/);
});

test('relay-orchestrate requires immutable policy coordination and explicit promotion', async () => {
  const skill = await readRepositoryFile('.agents/skills/relay-orchestrate/SKILL.md');
  assert.match(skill, /full verified Git commit explicitly approved/i);
  assert.match(skill, /active-policy reference.*same commit.*digest.*approval evidence/i);
  assert.match(skill, /gate.*before the version 2 reservation.*held through every capability check.*host dispatch.*response validation/is);
  assert.match(skill, /six-field duplicate key.*policy digest.*source commit.*requirements version/is);
  assert.match(skill, /clean unambiguous result.*release only the transient gate.*reservation remains permanent/is);
  assert.match(skill, /crash.*corrupt or legacy evidence.*ambiguous result.*STOP.*reconciliation/is);
  assert.match(skill, /policy promotion.*separate explicitly approved operation/i);
  assert.match(skill, /never reclaim a stale gate.*retry an attempt.*delete a claim/i);
});

test('relay-orchestrate fails closed during issue and repository preflight', async () => {
  const [skill, issueTracker] = await Promise.all([
    readRepositoryFile('.agents/skills/relay-orchestrate/SKILL.md'),
    readRepositoryFile('docs/agents/issue-tracker.md'),
  ]);

  assert.match(skill, /exactly one.*explicit.*issue number/i);
  assert.match(skill, /issue body.*authoritative.*scope/i);
  assert.match(skill, /comments?.*only.*explicitly approved/i);
  assert.match(skill, /open and readable/i);
  assert.match(skill, /staged.*unstaged.*untracked/is);
  assert.match(skill, /current branch.*`main`/i);
  assert.match(
    skill,
    /`git ls-remote --exit-code <upstream-remote> refs\/heads\/main`/,
  );
  assert.doesNotMatch(skill, /\bgit fetch\b|fetching for this proof/i);
  assert.match(skill, /preflight and planning.*remain non-mutating.*gates pass/is);
  assert.match(skill, /local `main`.*configured upstream.*live remote.*identical/is);
  assert.match(skill, /record.*base SHA/i);
  assert.match(skill, /never.*clean.*reset.*stash.*discard/is);
  assert.match(skill, /unavailable or ambiguous.*STOP/is);
  assert.match(issueTracker, /--json number,title,state,body,labels,comments/);
});

test('relay-orchestrate binds every GitHub operation to one recorded repository identity', async () => {
  const skill = await readRepositoryFile('.agents/skills/relay-orchestrate/SKILL.md');

  assert.match(skill, /canonical GitHub repository identity/i);
  assert.match(skill, /`nameWithOwner`/);
  assert.match(skill, /recorded orchestration state/i);
  assert.match(
    skill,
    /fetch URL.*push URL.*agree.*candidate.*host.*repository.*before.*GitHub provider operation/is,
  );
  assert.match(
    skill,
    /`gh repo view <canonical-gh-repository> --json nameWithOwner,url`/,
  );
  assert.match(
    skill,
    /`gh issue view <issue-number> --repo <canonical-gh-repository>/,
  );
  assert.match(
    skill,
    /every later.*standard `gh`.*read.*write.*`--repo <canonical-gh-repository>`/is,
  );
  assert.match(
    skill,
    /planner.*implementer.*reviewer.*canonical repository identity/is,
  );
  assert.match(
    skill,
    /configured upstream.*fetch URL.*push URL.*canonical repository identity/is,
  );
  assert.match(skill, /revalidate.*push URL.*immediately before.*push/is);
  assert.match(
    skill,
    /base repository identity.*`?<canonical-repository>`?.*base ref.*`main`.*head repository identity.*`?<canonical-repository>`?.*head ref.*recorded issue branch.*head SHA.*reviewed HEAD/is,
  );
  assert.match(
    skill,
    /`Closes #<issue-number>`.*same canonical repository/is,
  );
  assert.match(skill, /repository identity.*cannot be proven.*STOP/is);
});

test('relay-orchestrate uses host-bound REST PR verification and fails closed on bad evidence', async () => {
  const skill = await readRepositoryFile('.agents/skills/relay-orchestrate/SKILL.md');

  assert.doesNotMatch(skill, /baseRepository/);
  assert.match(
    skill,
    /`gh api --hostname <canonical-host> repos\/<canonical-repository>\/pulls\/<pr-number>`/,
  );
  assert.match(
    skill,
    /`number`.*`html_url`.*`base\.repo\.full_name`.*`base\.ref`.*`head\.repo\.full_name`.*`head\.ref`.*`head\.sha`/is,
  );
  assert.match(
    skill,
    /PR number.*PR URL.*base repository.*base ref.*head repository.*head ref.*head SHA/is,
  );
  assert.match(
    skill,
    /returned PR number.*recorded PR number.*PR URL.*recorded PR URL/is,
  );
  assert.match(
    skill,
    /base repository identity.*<canonical-repository>.*base ref.*`main`/is,
  );
  assert.match(
    skill,
    /head repository identity.*<canonical-repository>.*head ref.*recorded issue branch/is,
  );
  assert.match(skill, /head SHA.*independently reviewed HEAD/is);
  assert.match(
    skill,
    /Missing, malformed, ambiguous, wrong-host, wrong-repository, wrong-branch, or wrong-SHA PR evidence is a STOP condition/,
  );
  assert.match(skill, /`--hostname <canonical-host>`/);
  assert.match(skill, /`repos\/<canonical-repository>\/\.\.\.`/);
  assert.match(
    skill,
    /never.*`\{owner\}`.*`\{repo\}`.*current-directory.*remote.*`GH_REPO`.*default-host inference/is,
  );
  assert.match(
    skill,
    /conflicting.*`GH_HOST`.*host-qualified.*selector.*STOP/is,
  );
  assert.match(
    skill,
    /shadow `GH_HOST`.*non-canonical sentinel.*`gh repo view <canonical-gh-repository>/is,
  );
  assert.match(
    skill,
    /issue.*PR.*workflow run.*check.*commit status.*`--repo <canonical-gh-repository>`/is,
  );
  assert.match(
    skill,
    /every PR refresh.*host-bound REST PR verification/is,
  );
});

test('relay-orchestrate preserves role boundaries and ordered handoffs', async () => {
  const skill = await readRepositoryFile('.agents/skills/relay-orchestrate/SKILL.md');

  assert.match(skill, /fresh.*planner.*context/i);
  assert.match(skill, /invoke `relay-plan`.*same issue/is);
  assert.match(skill, /plan status.*exactly `READY`/i);
  assert.match(skill, /`BLOCKED`.*STOP/is);
  assert.match(skill, /unresolved material human decision.*STOP/is);
  assert.match(skill, /planner output.*advisory/i);
  assert.match(skill, /issue remains authoritative/i);

  assert.match(skill, /Unicode NFKD/i);
  assert.match(skill, /combining marks.*`\\p\{M\}`/i);
  assert.match(skill, /outside ASCII `\[a-z0-9\]`.*hyphen/is);
  assert.match(skill, /truncate.*64 ASCII characters/is);
  assert.match(
    skill,
    /`issue-17-feat-add-engineering-workflow-orchestrator`/,
  );
  assert.match(skill, /`issue-42-fix-cafe-crm-sync`/);
  assert.match(skill, /`issue-7-api-v2-retries`/);
  assert.match(
    skill,
    /commit subject.*`<normalized-title> \(#<issue-number>\)`/is,
  );
  assert.match(skill, /`feat: add engineering workflow orchestrator \(#17\)`/);
  assert.match(skill, /`Fix Café \/ CRM sync!!! \(#42\)`/);
  assert.match(skill, /`API v2 — retries \(#7\)`/);
  assert.match(skill, /local or remote.*already exists.*STOP/is);
  assert.match(
    skill,
    /immediately before creating.*issue branch.*repeat the complete base proof/is,
  );
  assert.match(
    skill,
    /current branch.*`main`.*worktree.*clean.*local `main`.*recorded base SHA.*configured upstream `main`.*recorded base SHA.*fresh.*`git ls-remote --exit-code <upstream-remote> refs\/heads\/main`.*live remote `main`.*recorded base SHA/is,
  );
  assert.match(
    skill,
    /remote `main` advanced.*identity differs.*STOP/is,
  );
  assert.match(skill, /never implement.*`main`/i);
  assert.match(skill, /fresh.*implementer.*context/i);
  assert.match(skill, /invoke `relay-implement`.*same issue/is);
  assert.match(skill, /implementer.*independently validate/i);
  assert.match(skill, /implementer.*must not.*commit.*push.*pull request/is);
});

test('relay-orchestrate gates, commits, and reviews one fixed implementation', async () => {
  const skill = await readRepositoryFile('.agents/skills/relay-orchestrate/SKILL.md');

  assert.match(skill, /diff.*issue-scoped/i);
  assert.match(skill, /issue-specific verification/i);
  assert.match(skill, /`npm run typecheck`/);
  assert.match(skill, /`npm run verify`/);
  assert.match(skill, /failed.*skipped.*incomplete.*STOP/is);
  assert.match(skill, /unexpected worktree paths.*STOP/is);
  assert.match(
    skill,
    /immediately after `relay-implement` returns.*before.*staging.*committing/is,
  );
  assert.match(skill, /current branch.*recorded issue branch/is);
  assert.match(skill, /HEAD.*recorded base SHA/is);
  assert.match(skill, /`git rev-list --count <recorded-base-sha>\.\.HEAD`.*exactly `0`/is);
  assert.match(skill, /staged.*unstaged.*untracked.*expected changed-path allowlist/is);
  assert.match(skill, /any mismatch.*STOP/is);
  assert.match(skill, /record.*base SHA.*implementation HEAD SHA/is);
  assert.match(skill, /clean worktree.*after.*commit/is);
  assert.match(skill, /do not push yet/i);

  assert.match(skill, /fresh.*independent reviewer.*context/i);
  assert.match(skill, /exact.*base.*HEAD.*fixed point/is);
  assert.match(skill, /do not provide.*planner.*implementer.*authority/is);
  assert.match(skill, /machine-readable.*review/i);
  assert.match(
    skill,
    /exact `MERGE`.*blocking defect count.*zero.*required verification.*exact `SUCCESS`/is,
  );
  assert.match(skill, /reviewed base SHA.*reviewed HEAD SHA/is);
  assert.match(skill, /`CHANGES`.*`FURTHER_DESIGN_REVIEW`.*STOP/is);
});

test('relay-orchestrate publishes only the reviewed head and validates exact-head CI', async () => {
  const skill = await readRepositoryFile('.agents/skills/relay-orchestrate/SKILL.md');

  assert.match(skill, /immediately before.*push/is);
  assert.match(skill, /HEAD.*exact reviewed HEAD/i);
  assert.match(skill, /worktree.*clean/i);
  assert.match(skill, /movement.*STOP.*new independent review/is);
  assert.match(
    skill,
    /immediately before.*push.*fresh.*`git ls-remote <upstream-remote> refs\/heads\/<issue-branch>`.*exact remote issue branch.*does not exist/is,
  );
  assert.match(skill, /collision or ambiguous remote state.*STOP/is);
  assert.match(
    skill,
    /create-only.*expected-absence.*`git push --force-with-lease=refs\/heads\/<issue-branch>: <upstream-remote> <reviewed-head>:refs\/heads\/<issue-branch>`/is,
  );
  assert.match(skill, /guard.*cannot advance.*remote branch/is);
  assert.match(skill, /push.*exact reviewed.*commit/is);
  assert.match(skill, /pull request.*target.*`main`/is);
  assert.match(skill, /`Closes #<issue-number>`/);
  assert.match(skill, /PR.*base repository.*head repository.*reviewed HEAD/is);
  assert.match(skill, /report.*PR number.*URL/is);

  assert.match(skill, /pending.*in-progress.*terminal/is);
  assert.match(skill, /workflow revision/i);
  assert.match(skill, /checkout-identity proof/i);
  assert.match(skill, /tested head/i);
  assert.match(skill, /missing.*stale.*cancelled.*timed out.*superseded.*failed.*older/is);
  assert.match(skill, /reconfirm.*PR head.*not changed/is);
  assert.match(skill, /PR ready for human merge/);
});

test('relay-orchestrate excludes autonomous selection, remediation, and merge', async () => {
  const skill = await readRepositoryFile('.agents/skills/relay-orchestrate/SKILL.md');

  assert.match(skill, /must not.*poll.*select.*issue/is);
  assert.match(skill, /no automatic remediation.*re-review loop/i);
  assert.match(skill, /must not.*merge.*auto-merge.*deploy.*close the issue/is);
  assert.match(skill, /Taylor.*final merge decision/i);
});
