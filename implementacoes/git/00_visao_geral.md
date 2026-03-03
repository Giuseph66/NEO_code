# 🎯 Visão Geral do Planejamento Git + IA no NeoCode

Este diretório contém os planos de implementação detalhados para evoluir o suporte nativo ao Git dentro do ecossistema NeoCode, fortemente integrado com Inteligência Artificial (Swarm Agents).

A ideia principal não é competir com extensões complexas, mas **embutir fluxos inteligentes e autônomos** diretamente na interface que os desenvolvedores já utilizam, criando uma experiência "Mágica" e sem atritos.

## 📁 Estrutura do Planejamento

Cada arquivo detalha um escopo específico para que a implementação possa ser modular e faseada:

1.  **`01_smart_commits.md`**: Geração Inteligente de Commits Automáticos (Conventional Commits + Análise de Código).
2.  **`02_code_review_agent.md`**: Agente de Revisão de Código Contínua (Pre-commit/Pre-push hook com IA).
3.  **`03_visual_history_insights.md`**: Exploração Visual do Histórico com Insights da IA (Blame inteligente, resumos de evolução de arquivos).
4.  **`04_conflict_resolution.md`**: Resolução de Conflitos Guiada por Agentes (Entendendo o contexto e sugerindo merges).

---

## 🤖 A Filosofia da Inteligência Artificial no Git do NeoCode

A IA não deve ser apenas uma ferramenta que gera texto. Ela deve **entender o contexto arquitetural** do projeto.

### 🌟 Pilares da Implementação com IA:
*   **Contexto Amplo**: A IA (ex: Gemini/Qwen) não olha apenas para o *diff*. Ela analisa o *diff* em conjunto com a árvore de dependências do arquivo modificado e arquivos relacionados que foram alterados na mesma sessão.
*   **Proatividade**: O Swarm deve prever a próxima ação. Se o desenvolvedor resolveu um bug, o Agente de Commit já deve deixar um resumo engatilhado no padrão da empresa.
*   **Aprendizado Contínuo**: As sugestões (de commits, resoluções de conflito) aprovadas pelo usuário retroalimentam o sistema (via contexto local) para adaptar o tom e o estilo.

---

> **Próximos Passos:** Analisar cada arquivo de planejamento individualmente para iniciar a execução de desenvolvimento.
