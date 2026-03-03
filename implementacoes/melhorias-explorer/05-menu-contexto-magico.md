# 5. Menu de Contexto "Mágico" (Botão Direito)

## Objetivo
Trazer a capacidade de ação dos agentes do Swarm para o menu de contexto nativo do explorador, disparando tarefas em lote para arquivos ou diretórios inteiros.

## Funcionalidades Propostas
- **"NeoCode: Explicar esta Pasta":** Lê todos os arquivos em um diretório e gera um `README.md` arquitetural.
- **"NeoCode: Gerar Testes para a Pasta":** Dispara uma fila de tarefas silenciosas para criar/atualizar testes de cada arquivo na pasta selecionada.
- **"NeoCode: Encontrar Bugs de Segurança":** Realiza um pente-fino de segurança focado estritamente na pasta clicada.

## Implementação Técnica
- Contribuir comandos via `package.json` vinculados ao escopo do menu `explorer/context`.
- Ao o comando ser acionado, as Uris do contexto da árvore do explorer são redirecionadas para a API de intenção do `NeocodeSwarm`.
- A injeção na arquitetura seria silenciosa, executada como background task que apenas avisa no chat (ou StatusBar) o progresso.
