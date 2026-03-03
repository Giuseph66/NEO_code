# 02 - Code Review Agent (Agente de Revisão Contínua)

## 📌 Objetivo
Criar uma camada heurística inteligente em tempo real (ou na fase de Pré-commit/Pré-push) que atua como um revisor de código sênior incansável, focando não apenas na sintaxe, mas em:
*   Vulnerabilidades arquiteturais e de segurança
*   Débitos técnicos
*   Consistência estrutural
*   Performance (Avisos O(N^2) disfarçados)

---

## 🤖 Integração da IA (O Agente Code Reviewer)

### Lógica de Operação
Este agente não apenas injeta texto (como o Smart Commits). Ele **escreve comentários de revisão no formato de "Problemas" (Diagnostics) na própria view do editor**, como se fosse o ESLint.

1.  **Gatilhos**: Pode ser disparado **onSave** (salvamento de arquivo), ou como um pré-requisito ativado antes do `git push` via um Hook virtual ou comando de painel SCM (ex: *Review Before Push*).
2.  **Prompt Analítico do Agente**:
    > "Analise o arquivo `/src/...` . Foque em más práticas de engenharia de software (Clean Code, Design Patterns, Naming Conventions). Ignore estilo de formatação pura (espaçamento, aspas), foque apenas na arquitetura. Se houver issues, responda ESTRITAMENTE num JSON com linha, criticidade (Alta/Média/Baixa) e a mensagem explicativa."
3.  **Filtragem de Falsos Positivos**: O `neocodeSwarmOrchestrator` implementa uma lógica para desconsiderar regras já silenciadas ou arquivos fora do escopo do usuário (arquivos muito antigos não modificados).

## 💻 Passos de Implementação (Técnico)
1.  **Orquestrador de Revisão (Typescript Core)**:
    *   Criar um sub-orchestrator (`NeoCodeReviewOrchestrator.ts`).
    *   Este orquestrador usará a API `vscode.languages.createDiagnosticCollection('neocode-ai-review')` para gerenciar os avisos amarelos/vermelhos (warnings/errors) na aba *Problems*.
2.  **Interface SCM & Editor**:
    *   Adicionar na "Titlebar" do editor (semelhante ao *Copilot*) ou na view "Agentes", um botão rápido `Run AI Review em <Nome do Arquivo>`.
3.  **Parse de Resposta (JSON)**: Traduzir a saída rígida JSON da IA para a API do VS Code `new vscode.Diagnostic(range, mensagem, autoridade)`.
4.  **Aprovação / Silenciamento**: Cada Diagnostic da IA pode ter um *Quick Fix* acoplado (Ação da Lâmpada `💡`), que envia outro pedido para o Swarm sugerir a correção.
