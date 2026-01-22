# Security Policy

## Supported Versions

We provide security updates for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | ✅ Yes             |
| < 1.0   | ❌ No              |

## Reporting a Vulnerability

**IMPORTANT: Do NOT open public GitHub issues for security vulnerabilities.**

### How to Report

**Email:** security@adverant.ai

**Response Time:**
- Initial acknowledgment: 48 hours
- Investigation and patch timeline: 7-14 days
- Critical vulnerabilities: 24-72 hours

### What to Include

Please provide:
1. Description of the vulnerability
2. Steps to reproduce
3. Potential impact assessment
4. Suggested fix (if available)
5. Your contact information for follow-up

### Process

1. **Report:** Email security@adverant.ai with details
2. **Acknowledgment:** We'll confirm receipt within 48 hours
3. **Investigation:** We'll investigate and develop a patch
4. **Coordination:** We'll coordinate disclosure timeline with you
5. **Disclosure:** Public disclosure after patch is available
6. **Credit:** You'll receive credit in the security advisory (optional)

### Scope

We are interested in vulnerabilities including:

- **Authentication & Authorization**
  - Authentication bypass
  - Privilege escalation
  - Session management issues

- **Data Security**
  - SQL injection
  - Data exposure
  - Insecure data storage

- **Code Execution**
  - Remote code execution (RCE)
  - Command injection
  - Arbitrary file read/write

- **API Security**
  - API authentication bypass
  - Rate limiting bypass
  - SSRF (Server-Side Request Forgery)

- **Infrastructure**
  - Container escape
  - Kubernetes misconfigurations
  - Supply chain vulnerabilities

### Out of Scope

The following are generally out of scope:
- Denial of Service (DoS) attacks
- Social engineering
- Physical security
- Issues in dependencies (report to upstream projects)

### Security Rewards

We may offer recognition or rewards for significant vulnerability reports on a case-by-case basis. Contact security@adverant.ai for details.

## Security Best Practices

When deploying Adverant Nexus:

1. **Use Strong Authentication**
   - Enable API key rotation
   - Use strong, unique passwords
   - Implement multi-factor authentication where possible

2. **Network Security**
   - Use TLS/SSL for all communications
   - Restrict network access via firewalls
   - Use private networks for internal services

3. **Keep Updated**
   - Monitor security advisories
   - Apply patches promptly
   - Subscribe to security announcements

4. **Secure Configuration**
   - Change default credentials
   - Disable unnecessary services
   - Follow the principle of least privilege

5. **Monitoring**
   - Enable audit logging
   - Monitor for suspicious activity
   - Set up alerts for security events

## Security Advisories

Security advisories will be published at:
- GitHub Security Advisories: https://github.com/adverant/Adverant-Nexus-Open-Core/security/advisories
- Mailing list: security-announce@adverant.ai

## Contact

For questions about this security policy:
- Email: security@adverant.ai
- PGP Key: Available on request
