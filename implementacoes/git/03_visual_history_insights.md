# 03 - Visual History Insights (Exploração do Histórico Visualmente e com IA)

## 📌 Objetivo
Anotações de *blame* tradicionais dizem "quem" fez a linha. Queremos que a IA explique o **"por quê"** de um trecho complexo ou refatoração estrutural antiga existir, de forma nativa e visual (Estilo *GitLens*).

## 🛠️ O Problema Atual
Ao encontrar código "macarrônico" escrito por um ex-funcionário num arquivo gigantesco, ler apenas a anotação `fix bug do token` e tentar entender a base inteira é absurdamente longo.

---

## 🤖 Integração da IA (Insights Arquiteturais do Histórico)

### Funcionalidade 1: "AI Blame Explanation" (Painel Lateral de Insights)
1.  **Acionamento**: Ao passar o mouse por um trecho de código modificado por um membro da equipe 2 anos atrás, o *Hover Provider* nativo do editor invoca a API do Git local, buscando o hash do commit dessa linha.
2.  **Análise Swarm Rápida**: O agente baixa silenciosamente o `git show <commit-hash>` (o diff inteiro daquele PR histórico).
3.  **Resultado no Editor**: O *Hover Tooltip* do usuário (ao passar o mouse por cima do código) ganha uma injeção de texto com o título "🤖 AI Insight Histórico":
    *   "Esta lógica foi introduzida no Commt XYZ por Fulano para resolver especificamente um bloqueio de escalabilidade X. O contexto global do commit tocava nestes 4 módulos correlatos..."

### Funcionalidade 2: "Time Machine Automático"
1.  Uma Timeline visual injetada no VS Code para mostrar como um diretório crítico, ou fluxo, evoluiu por "Fases" traduzidas do histórico git e resumos da IA. "Fase 1: Migração para Next.js (25 Commits, 4 Meses)". "Fase 2: Adição do OAuth (15 Commits, 2 Semanas)".

## 💻 Passos de Implementação (Técnico)
1.  **Integração VS Code Timeline API**:
    *   Integrar o `neocodeSwarm` ao painel de Timeline nativo do VS Code (abaixo do Explorer - API `.registerTimelineProvider('neocode-git-insights', ...)`).
2.  **API VS Code Hover Provider (`vscode.languages.registerHoverProvider`)**:
    *   Fornecer resumos sob demanda no código, processando assincronamente (com cache/SQLite leve persistido pelo NeoCode).
3.  **Estratégia Anti-custo (Tokens)**: Modelos LLM demoram se pedidas múltiplas revisões de histórico. A integração de *Hover* precisa rodar scripts RAG muito otimizados ou ter *pre-fetchs* (fazer fetch das explicações da branch principal periodicamente em background e salvar em cache).
