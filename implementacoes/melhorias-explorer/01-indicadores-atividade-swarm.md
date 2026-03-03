# 1. Indicadores de Atividade do Swarm (Tempo Real)

## Objetivo
Visualizar o que os Agentes de IA estão fazendo sem precisar abrir o chat através de indicadores visuais (badges/cores) no explorador de arquivos.

## Funcionalidades Propostas
- **Analisando (🔵):** Indicar quando um agente está lendo um arquivo atual.
- **Modificado pela IA (🟡):** Destacar arquivos com alterações pendentes de revisão ou recém-sugeridos pelo NeoCode.
- **Otimizado (🟢):** Sinalizar arquivos que foram validados/testados com sucesso pela IA.

## Implementação Técnica
- Utilizar a API de `FileDecorationProvider` nativa do VS Code.
- Criar um Event Emitter no `NeocodeSwarm` central que dispara eventos de broadcast de estado associados a `URI`s de arquivos.
- O provider vai se registrar e escutar esses eventos e aplicar a `FileDecoration` (cor e tooltip simples) na árvore do explorador sem interromper o fluxo do usuário.
