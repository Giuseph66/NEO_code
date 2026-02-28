# NeoCode Swarm Capability Catalog

Este diretorio documenta as capacidades globais carregadas por padrao no Swarm.

## Como funciona

- O catalogo principal fica em:
  - `personalities.json`
  - `skills.json`
  - `hooks.json`
  - `commands.json`
- O arquivo `../neocodeSwarmCapabilityCatalog.ts` apenas tipa e exporta esses JSONs.
- Cada `skill` possui:
  - `description`
  - `instructionPath` apontando para um `SKILL.md` completo no diretorio `models/`.
- Os `hooks` usam `scriptPath` para `hooks.json`.
- Os `commands` usam `executablePath` para o arquivo de comando (`.md` ou `.toml`).

## Objetivo

Evitar listas rasas apenas com `name/type` e manter referencia explicita para instrucoes completas em Markdown.

## Observacao

As instrucoes completas (o que pode e nao pode fazer) estao nos arquivos referenciados em `instructionPath`.
