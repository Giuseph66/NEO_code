# 3. Busca e Filtro Semântico (Natural Language File Search)

## Objetivo
Permitir que o usuário busque e filtre arquivos no explorador usando linguagem natural (busca semântica), encontrando arquivos pelo contexto e não apenas pelo nome.

## Funcionalidades Propostas
- Input de texto ou paleta de comando onde se busca: ex. `"lógica de login"` ou `"tema escuro"`.
- O explorador filtrará a árvore de arquivos, mostrando apenas os arquivos que contêm lógica de autenticação (ex: `auth.ts`, `session.js`, `userController.ts`) mesmo se o nome não ajudar.

## Implementação Técnica
- Integrar embeddings locais ou cache de contexto semântico do Workspace.
- Quando o usuário buscar, realizar a consulta vetorial para gerar uma lista de URIs correspondentes ao contexto no NeoCode Swarm.
- Criar um comando customizado ou modificar o `Filter` nativo do `ExplorerViewlet` para ocultar os nós (nodes) que não dão match com os resultados semânticos.
