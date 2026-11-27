### Cron format:
`minute hour day month weekday`. Examples:
- `0 8 * * *` = every day at 8:00
- `*/30 * * * *` = every 30 minutes
- `0 9 * * 1-5` = weekdays at 9:00

## Skill
```bash
mkdir -p .claude/skill-javaslat && cat > .claude/skill-javaslat/SKILL.md << 'SKILLEOF'
---
name: skill-name
description: When to use it, what it does. Be specific in the triggers.
---
# Skill name

## When to use
[Specific triggers and contexts]

## Procedure
1. [First step]
2. [Second step]
...

## Pitfalls
- [A known problem and its fix]

## Verification
- [How to validate the result]
SKILLEOF
bash scripts/marveen-api.sh skill-propose SKILL-NEV .claude/skill-javaslat/SKILL.md --reason-file .claude/skill-javaslat/indok.txt
```


According to Anthropic's skill-writing guide (Skill authoring best practices, https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices):
- "Keep SKILL.md body under 500 lines for optimal performance": the SKILL.md body (the part after the frontmatter) is at most 500 lines. The details go under `references/`, linked from the SKILL.md.
- "For reference files longer than 100 lines, include a table of contents at the top": a reference file longer than 100 lines has a table of contents at the top, because Claude "might use commands like head -100 to preview content rather than reading entire files".
- "Keep references one level deep from SKILL.md": every helper file is pointed to directly by the SKILL.md (with a markdown link), not by another helper file.
- An important, fragile step should be a script (low degree of freedom), not a text instruction.
