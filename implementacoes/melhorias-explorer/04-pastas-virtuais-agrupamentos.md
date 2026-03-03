# 4. Pastas Virtuais e Agrupamentos Inteligentes

## Objetivo
Criar uma "Visualização de Domínio" onde o explorador agrupa logicamente os arquivos pela arquitetura e escopo de negócios, independente de sua localização física no disco.

## Funcionalidades Propostas
- Gerar grupos/pastas virtuais dinâmicas: ex. "Modelos de Dados", "Componentes de UI", "Configurações".
- Puxar arquivos de múltiplos locais do projeto para dentro do mesmo agrupamento virtual.
- Alternar facilmente entre "Visualização Física" e "Visualização Semântica".

## Implementação Técnica
- Criar um `TreeDataProvider` customizado (`NeocodeSemanticExplorer`) registrado em uma nova `view` nativa do painel lateral.
- Uma rotina background (Agente) lerá periodicamente os metadados do projeto para categorizar os arquivos.
- A árvore customizada irá consumir essas categorias e renderizar os "Nós Pai" como pastas virtuais, e os nós filhos como referências de arquivos que abrem o editor de texto real correspondente ao serem clicados.
