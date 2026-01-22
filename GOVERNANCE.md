# Governance Model

## Overview

Adverant Nexus Open Core follows a **meritocratic governance model** where contributors earn maintainer status through sustained, high-quality contributions. This document outlines roles, responsibilities, and decision-making processes.

---

## Roles

### 1. Users

**Definition**: Anyone using Nexus in their projects.

**Rights**:
- Use the software under the terms of the license
- Report bugs and request features
- Participate in community discussions

**No obligations required**

---

### 2. Contributors

**Definition**: Anyone who has submitted an accepted pull request or made significant non-code contributions (documentation, community support, etc.).

**Rights**:
- Submit issues and pull requests
- Comment on issues and pull requests
- Participate in GitHub Discussions
- Vote in community polls
- Recognition in CONTRIBUTORS.md

**Responsibilities**:
- Follow the Code of Conduct
- Adhere to contribution guidelines
- Respond to feedback on contributions

**How to Become a Contributor**:
- Submit a pull request that gets merged, OR
- Make significant documentation improvements, OR
- Provide sustained community support

---

### 3. Maintainers

**Definition**: Contributors with commit access who have demonstrated sustained commitment and technical expertise.

**Criteria for Maintainership**:
- **10+ merged pull requests** (or equivalent contributions)
- **3+ months of active participation**
- **Understanding of project architecture** and design principles
- **Adherence to code quality standards**
- **Demonstrated collaboration skills**
- **Commitment to the Code of Conduct**

**Rights**:
- Merge pull requests
- Create and manage releases
- Triage and label issues
- Participate in RFC discussions with voting rights
- Moderate community discussions
- Access to private maintainer channels

**Responsibilities**:
- **Review pull requests** within 48 hours (business days)
- **Maintain code quality** standards
- **Support community members** in discussions and issues
- **Uphold the Code of Conduct** and enforce when necessary
- **Participate in governance decisions**
- **Mentor new contributors**
- **Maintain areas of ownership** (see CODEOWNERS)

**How to Become a Maintainer**:
1. Meet the criteria above
2. Be nominated by an existing maintainer OR self-nominate
3. Receive approval from 2/3 of existing maintainers
4. Complete onboarding process (access setup, documentation review)

---

### 4. Core Team

**Definition**: Maintainers who guide the strategic direction of the project.

**Current Members**:
- **Don** (Founder, Architecture Lead)
- *Open for nominations*

**Additional Responsibilities**:
- Define project vision and strategy
- Make final decisions on contentious issues
- Represent the project publicly
- Coordinate major releases
- Manage security vulnerabilities
- Oversee governance process

**How to Join the Core Team**:
1. Be an active maintainer for 6+ months
2. Demonstrate strategic thinking and leadership
3. Nomination by existing core team member
4. Unanimous approval by existing core team

---

## Decision Making

### Minor Changes

**Examples**: Bug fixes, documentation updates, refactoring, small features

**Process**:
- **Single maintainer approval** sufficient
- Non-controversial changes can be self-merged after 24 hours with no objections

**Timeline**: 1-3 days

---

### Major Changes

**Examples**: New features, breaking changes, architecture modifications, API changes

**Process**:
1. **RFC (Request for Comments)** posted in GitHub Discussions
2. **Community feedback** period (minimum 7 days)
3. **2+ maintainer approvals** required
4. **Core team veto** possible for strategic concerns

**Timeline**: 7-14 days

**RFC Template**:
```markdown
## Summary
Brief description of the change

## Motivation
Why is this needed?

## Detailed Design
Technical implementation details

## Drawbacks
What are the downsides?

## Alternatives
What other approaches were considered?

## Unresolved Questions
What needs to be decided?
```

---

### Emergency Security Fixes

**Process**:
- **Security team** (subset of maintainers) can merge without review
- **Post-merge review** required within 24 hours
- **Notification** to all maintainers immediately after merge

**Timeline**: As fast as possible

---

### Governance Changes

**Examples**: Changes to this GOVERNANCE.md document, changes to project structure

**Process**:
1. RFC with 14-day feedback period
2. **75% core team approval** required
3. **Community input** considered but not binding

**Timeline**: 14-30 days

---

## Contribution Recognition

### Monthly Contributor Highlights
- Announced in Discord and GitHub Discussions
- Featured on project blog
- Social media recognition

### CONTRIBUTORS.md
- All contributors listed
- Updated monthly
- Recognition for code and non-code contributions

### Annual Community Awards
- Outstanding Contributor
- Best Plugin Developer
- Community Champion
- Documentation Hero

### Perks
- Maintainers receive:
  - Recognition on website
  - Early access to new features
  - Direct communication channel with core team
  - Invitation to maintainer summits (if/when held)

---

## Conflict Resolution

### Process for Disagreements

1. **Direct Discussion**: Parties attempt to resolve directly
2. **Mediation**: Uninvolved maintainer mediates
3. **Core Team Decision**: Core team makes final decision if unresolved
4. **Code of Conduct Violation**: Refer to CODE_OF_CONDUCT.md enforcement

### Appeal Process

- Decisions can be appealed to the core team
- Appeals must be made within 14 days
- Core team reviews within 7 days
- Final decision is binding

---

## Offboarding

### Inactive Maintainers

- Maintainers inactive for **6+ months** may be moved to "Emeritus Maintainer" status
- Retain recognition but lose commit access
- Can return to active status upon request

### Voluntary Step-Down

- Maintainers can step down at any time
- Encouraged to give 30-day notice for smooth transition
- Recognized as "Emeritus Maintainer"

### Removal for Cause

- Serious Code of Conduct violations may result in removal
- Requires **unanimous core team approval**
- Right to appeal to independent arbitrator

---

## Transparency

### Public Information
- All governance discussions happen in public (GitHub Discussions)
- Maintainer meeting notes published
- Decision rationale documented

### Private Information
- Security vulnerabilities
- Code of Conduct investigations
- Personal information

---

## Amendments

This governance model can be amended through the Governance Changes process:
- RFC with 14-day feedback period
- 75% core team approval
- Community input considered

---

## Contact

For governance questions:
- **GitHub Discussions**: https://github.com/adverant/Adverant-Nexus-Open-Core/discussions
- **Email**: governance@adverant.ai
- **Discord**: https://discord.gg/adverant

---

**Version**: 1.0
**Last Updated**: 2026-01-03
**Next Review**: 2026-07-03 (6 months)
