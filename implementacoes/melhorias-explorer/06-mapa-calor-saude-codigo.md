# 6. Mapa de Calor de "Saúde" do Código (Code Health)

## Objetivo
Colorir o fundo ou aplicar ícones visuais diretamente na listagem de arquivos do explorador para criar um mapa de calor rápido do estado e qualidade da base de código.

## Funcionalidades Propostas
- Visualização instantânea de métricas por cores/ícones:
  - 🔴 Arquivos críticos (alta complexidade, risco de quebra, débito técnico).
  - 🟠 Arquivos com baixa cobertura de testes.
  - 🟢 Componentes limpos e atualizados com testes.

## Implementação Técnica
- Uso da API `FileDecorationProvider` do VS Code para aplicar badges visuais à direita do nome do arquivo na árvore (ex: `$(warning)`, `$(check)` ou cores hex customizadas predefinidas).
- Ferramentas externas acionadas pelo Swarm podem rodar em background para analisar métricas de complexidade e enviar esse log para o provedor de decorações do Explorer.
