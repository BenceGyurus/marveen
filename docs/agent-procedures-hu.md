### Cron formátum:
`perc óra nap hónap hétnapja` - Példák:
- `0 8 * * *` = minden nap 8:00
- `*/30 * * * *` = 30 percenként
- `0 9 * * 1-5` = hétköznap 9:00

## Skill
```bash
mkdir -p .claude/skill-javaslat && cat > .claude/skill-javaslat/SKILL.md << 'SKILLEOF'
---
name: skill-nev
description: Mikor használd, mit csinál. Legyél konkrét a triggerelésben.
---
# Skill neve

## Mikor használd
[Konkrét triggerek és kontextusok]

## Eljárás
1. [Első lépés]
2. [Második lépés]
...

## Buktatók
- [Ismert probléma és megoldása]

## Ellenőrzés
- [Hogyan validáld az eredményt]
SKILLEOF
bash scripts/marveen-api.sh skill-propose SKILL-NEV .claude/skill-javaslat/SKILL.md --reason-file .claude/skill-javaslat/indok.txt
```


Az Anthropic skill-írási útmutatója (Skill authoring best practices, https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) szerint:
- "Keep SKILL.md body under 500 lines for optimal performance": a SKILL.md törzse (a frontmatter utáni rész) legfeljebb 500 sor. A részletek a `references/` alá kerülnek, a SKILL.md-ből linkelve.
- "For reference files longer than 100 lines, include a table of contents at the top": a 100 sornál hosszabb referenciafájl tetején tartalomjegyzék áll, mert Claude "might use commands like head -100 to preview content rather than reading entire files".
- "Keep references one level deep from SKILL.md": minden segédfájlra közvetlenül a SKILL.md mutasson (markdown-linkkel), ne egy másik segédfájl.
- A fontos, törékeny lépés szkript legyen (alacsony szabadságfok), ne szöveges utasítás.
