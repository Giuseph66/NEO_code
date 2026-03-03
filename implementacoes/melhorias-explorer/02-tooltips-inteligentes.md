# 2. Tooltips Inteligentes (Resumo ao passar o mouse)

## Objetivo
Exibir um resumo gerado por IA sobre o escopo, complexidade e responsabilidade de um arquivo ou pasta ao passar o mouse por cima (hover).

## Funcionalidades Propostas
- Geração assíncrona on-demand de resumos ou leitura de cache local para não travar a interface.
- O tooltip exibirá:
  - O que o arquivo/pasta faz (1-2 frases).
  - Principais dependências ou funções exportadas.
  - Alerta de débitos técnicos (ex: falta de documentação, warnings).

## Implementação Técnica
- Registrar um `HoverProvider` que atua na árvore do Explorer (ou injetar comportamento nativo customizado).
- Como alternativa viável de API sem quebrar a UI restrita do VS Code Explorer: Usar `HoverProvider` padrão focado no uso editor ou contribuir para a view de detalhes.
- Mapear a integração ao modelo leve (Flash) com cache via armazenamento local (`memento` ou SQLite) de forma que hover seja instantâneo após a primeira geração.
