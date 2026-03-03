# Branches Atuais no Repositório

## Como Listar
As branches podem ser visualizadas com o comando:
```bash
git branch -a
```

## Estado Atual (NeoCode)

### Branches Locais
Essas são as branches que existem fisicamente no seu computador nesta pasta:
- `develop` (A branch atual na qual você está operando e comitado ativamente)
- `main`

### Branches Remotas
Essas são as branches do servidor (GitHub/GitLab/etc.):
- `origin/HEAD` -> Aponta para `origin/main`
- `origin/main`
- `origin/develop`
- *Dependabots*:
  - `origin/dependabot/github_actions/actions/checkout-6`
  - `origin/dependabot/github_actions/actions/setup-node-6`
  - `origin/dependabot/github_actions/actions/upload-artifact-7`

---

# Planejamento: Melhoria no Sistema de Branches (Proposta)

Para que possamos melhorar nossa estratégia e gestão do sistema de *branches* e evitar problemas como o do erro `branch already exists`, proponho a seguinte estrutura:

**1. Adoção do Git Flow Simplificado**
- **main**: Restrita. Apenas código totalmente testado e em versão final.
- **develop**: Branch principal de trabalho e integração da equipe. De onde todas as *features* partem.

**2. Padrão de Nomenclatura Sistematizada**
- `feature/<nome-da-funcionalidade>`: Para novos recursos. (ex: `feature/swarm-ui-refactor`).
- `bugfix/<nome-do-bug>`: Para correção de pequenos bugs ou refatorações (ex: `bugfix/branch-already-exists-error`).
- `hotfix/<nome-do-erro>`: Apenas para consertos urgentes diretamente na `main`.

**3. Cleanup e Gestão Contínua (Manutenção)**
- Sempre deletar branches locais (`git branch -d`) e remotas após ser mesclada no repositório.
- A cada *sprint* (ou fim de semana), podar branches removidas do remoto: `git fetch --prune`.

> Por favor, revise este documento e me informe quais outras mudanças operacionais eu devo corrigir no planejamento.
