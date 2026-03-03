# 04 - Resolução de Conflitos Dirigida por Agentes (Smart Merge)

## 📌 Objetivo
A resolução de conflitos de merge (Merge Conflicts) é uma das tarefas mais tensas e propensas a erros no Git. O objetivo é usar o Swarm NeoCode para atuar como um mediador inteligente, analisando as duas versões do código e a intenção de quem as escreveu, sugerindo a fusão perfeita.

## 🛠️ O Problema Atual
O VS Code nativo oferece divisões `< Current Change | Incoming Change >` e a opção rudimentar de `Accept Both`. Muitas vezes, `Accept Both` gera código sintaticamente inválido (duplicação de declarações, quebra de chaves) que requer fixação manual demorada.

---

## 🤖 Integração da IA (O Agente Mediador de Merge)

### Como o Swarm resolve conflitos?
1.  **Detecção do `<<<<<<< HEAD`**: O agente monitora o estado SCM (Source Control) do repositório procurando por arquivos com status `Conflicted` (`U`).
2.  **Extração Silenciosa com 3-Way Context**: O agente pega:
    *   A versão *Ours* (Current)
    *   A versão *Theirs* (Incoming)
    *   A versão *Base* (O último commit comum entre as duas branches) - *CRÍTICO para a IA entender quem mudou o quê!*
3.  **Análise Semântica (LLM)**: O contexto é enviado para o modelo via `neocodeSwarmOrchestrator`. Exemplo de prompt:
    > "Você tem 3 trechos: Base, HEAD (Current) e TARGET (Incoming). A branch current tentou adicionar a funcionalidade X. A branch incoming tentou refatorar a classe Y. Sua tarefa é integrar ambas as lógicas garantindo que a sintaxe seja válida em Typescript (ou linguagem alvo)."
4.  **Auto-fix de Conflito**:
    A IA não usa *Accept This* ou *Accept That*. Ela gera uma **3ª versão** fundida com maestria. O VS Code ganha um novo botão nativo brilhante no topo do conflito no editor: `🤖 Resolver Inteligente com Swarm`.

## 💻 Passos de Implementação (Técnico)
1.  **CodeLens Provider**: Usar a API nativa `vscode.languages.registerCodeLensProvider` ou substituir/estender o `MergeConflictDecorator` nativo.
2.  Adicionar uma linha clicável (CodeLens) com a opção: **🤖 Smart Resolve (NeoCode)** logo abaixo das opções nativas (Accept Current, Accept Incoming).
3.  **Processamento do AST**: Para conflitos extremamente simples (importações duplicadas em Node/JS), a IA pode até ser sobrepujada por heurísticas locais AST (Abstract Syntax Tree) rápidas que rodam sem atraso de API e apenas confirmam com o agente.
4.  **Integração no Painel "NeoCode Swarm"**: Adicionar uma visualização (View) durante merges chamada `Merge Assistant`, onde o agente lista *por que* ele fundiu o código de determinada maneira ("Preservei sua nova API call, mas usei o tratamento de erro da branch upstream").
