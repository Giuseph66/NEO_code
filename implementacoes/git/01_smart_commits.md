# 01 - Smart Commits (Geração Inteligente de Commits)

## 📌 Objetivo
Automatizar a criação de mensagens de commit de alta qualidade, forçando boas práticas (como *Conventional Commits*) sem adicionar sobrecarga cognitiva ao desenvolvedor.

## 🛠️ O Problema Atual
Desenvolvedores frequentemente usam mensagens genéricas ("fix", "update", "wip") devido à pressa, o que prejudica a geração de changelogs automáticos e o entendimento do histórico do projeto.

## 🚀 A Solução NeoCode
Um botão e um atalho (e.g., `Ctrl+Enter` / `Cmd+Enter` no painel SCM) que aciona um Agente do NeoCode Swarm para analisar os arquivos em *stage* e redigir a mensagem perfeita.

---

## 🤖 Integração da IA (O Agente de Commit)

### Fluxo de Trabalho da IA
1.  **Coleta de Dados**: O sistema extrai o resultado de `git diff --cached` (apenas as mudanças em *stage*).
2.  **Filtragem de Ruído**: Arquivos de *lock* (como `package-lock.json`) ou compilados são ignorados para economizar tokens.
3.  **Análise de Intenção**: O prompt da IA é projetado para deduzir a *intenção* da mudança:
    *   *Foi um bug fix?* (Ex: adicionei um try/catch, alterei condicional).
    *   *Foi uma feature?* (Ex: novos arquivos, exportações de novos métodos).
    *   *Foi refatoração?* (Ex: mudança estrutural sem alterar comportamento).
4.  **Geração do Padrão**: A IA formata a saída estritamente seguindo o *Conventional Commits*:
    ```
    <tipo>[escopo opcional]: <descrição curta>

    [corpo detalhado explicando o PORQUÊ e o QUE mudou]
    ```

### Prompt Sugerido (Conceitual)
> "Você é um engenheiro de software sênior. Analise o seguinte `git diff`. Gere uma mensagem de commit no padrão Conventional Commits. A primeira linha deve ter no máximo 50 caracteres. O corpo deve explicar o raciocínio clínico da mudança. Não repita o que o código já mostra, foque na motivação arquitetural."

## 💻 Passos de Implementação (Técnico)
1.  **Interface SCM**: Injetar um botão "🌟 Gerar Smart Commit" na view principal de Source Control do NeoCode.
2.  **Captura do Diff**: Usar a API nativa da extensão `git` (fornecida pela base do VS Code) para puxar apenas o que está em *index* (staged).
3.  **Orquestração via Swarm**: Enviar o payload para o `neocodeSwarmOrchestrator`, despachando para o modelo atual (Gemini/Qwen).
4.  **Auto-preenchimento**: Injetar a resposta diretamente na caixa de texto de input de mensagem de commit do painel SCM.
