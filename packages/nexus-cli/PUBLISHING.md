# Publishing Guide for @adverant-nexus/cli

This guide walks you through the complete process of publishing the Nexus CLI package to npm.

## Table of Contents

- [Pre-Publication Checklist](#pre-publication-checklist)
- [Version Management](#version-management)
- [Local Testing](#local-testing)
- [Publishing to npm](#publishing-to-npm)
- [Post-Publication Verification](#post-publication-verification)
- [Troubleshooting](#troubleshooting)
- [CI/CD Integration](#cicd-integration)

---

## Pre-Publication Checklist

Before publishing, ensure all these conditions are met:

### 1. Code Quality

- [ ] All TypeScript code compiles without errors
- [ ] Linting passes (`npm run lint`)
- [ ] All tests pass (`npm test`)
- [ ] Code formatting is consistent (`npm run format`)

```bash
# Run all quality checks
npm run typecheck
npm run lint
npm test
```

### 2. Documentation

- [ ] README.md is up-to-date
- [ ] ARCHITECTURE.md reflects current implementation
- [ ] All public APIs are documented
- [ ] CHANGELOG.md is updated with changes

### 3. Version Management

- [ ] Version number follows [Semantic Versioning](https://semver.org/)
- [ ] Version is incremented appropriately:
  - **Patch** (1.0.x): Bug fixes, minor changes
  - **Minor** (1.x.0): New features, backward compatible
  - **Major** (x.0.0): Breaking changes
- [ ] Git tags are created for releases

### 4. Package Configuration

- [ ] `package.json` metadata is complete and accurate
- [ ] `files` field lists all necessary files
- [ ] `.npmignore` excludes source files and development artifacts
- [ ] Dependencies are up-to-date and properly declared
- [ ] No sensitive data in source code

### 5. Build Artifacts

- [ ] Clean build completed (`npm run clean && npm run build`)
- [ ] `dist/` directory contains all compiled files
- [ ] Entry point (`dist/index.js`) exists and is executable
- [ ] Build size is reasonable (<10MB recommended)

---

## Version Management

### Understanding Semantic Versioning

Version format: `MAJOR.MINOR.PATCH[-PRERELEASE]`

- **MAJOR**: Breaking changes (e.g., 1.0.0 → 2.0.0)
- **MINOR**: New features, backward compatible (e.g., 1.0.0 → 1.1.0)
- **PATCH**: Bug fixes, minor changes (e.g., 1.0.0 → 1.0.1)
- **PRERELEASE**: Alpha, beta, rc versions (e.g., 1.0.0-beta.1)

### Bumping Versions

Use npm's built-in version commands:

```bash
# Patch version (bug fixes)
npm version patch

# Minor version (new features)
npm version minor

# Major version (breaking changes)
npm version major

# Prerelease version
npm version prerelease --preid=beta

# Specific version
npm version 2.1.0
```

These commands will:
1. Update `package.json` version
2. Create a git commit
3. Create a git tag

### Manual Version Update

If you prefer to update manually:

```bash
# 1. Edit package.json and update "version" field
# 2. Commit the change
git add package.json
git commit -m "chore: bump version to 2.1.0"

# 3. Create a git tag
git tag v2.1.0

# 4. Push commits and tags
git push origin main
git push origin --tags
```

---

## Local Testing

Before publishing to npm, thoroughly test the package locally.

### 1. Run Pre-Publish Validation

Our validation script checks everything automatically:

```bash
npm run validate
```

This will:
- ✓ Verify TypeScript compilation
- ✓ Check required files exist
- ✓ Validate package.json metadata
- ✓ Scan for sensitive data
- ✓ Verify dependencies
- ✓ Run tests
- ✓ Generate build report

### 2. Test Package Installation

Run the verification script to test the package in a clean environment:

```bash
npm run verify
```

This will:
- ✓ Create a tarball (`npm pack`)
- ✓ Install in a temporary directory
- ✓ Verify all files are included
- ✓ Test CLI commands work
- ✓ Check package size
- ✓ Clean up after tests

### 3. Test with npm link

Test the CLI globally on your system:

```bash
# Link the package globally
npm run link:global

# Test commands
nexus --version
nexus --help
nexus config list

# When done testing
npm run unlink:global
```

### 4. Test in a Real Project

Create a test project and install your package:

```bash
# Create test directory
mkdir /tmp/nexus-test
cd /tmp/nexus-test

# Initialize project
npm init -y

# Install from local tarball
npm pack /path/to/nexus-cli
npm install adverant-nexus-cli-2.0.0.tgz

# Test commands
npx nexus --version
npx nexus init
```

### 5. Dry Run Publication

Preview what will be published without actually publishing:

```bash
npm run publish:dry
```

This shows:
- Package name and version
- Files that will be included
- Package size
- Where it will be published

---

## Publishing to npm

### Prerequisites

1. **npm Account**: Create an account at [npmjs.com](https://www.npmjs.com/signup)
2. **Authentication**: Log in to npm

```bash
npm login
```

3. **Organization Access** (for scoped packages): Ensure you're a member of `@adverant-nexus` organization

4. **Two-Factor Authentication**: Strongly recommended for publishing

```bash
npm profile enable-2fa auth-and-writes
```

### Publishing Steps

#### Step 1: Final Checks

```bash
# Pull latest changes
git pull origin main

# Ensure clean working directory
git status

# Run validation
npm run validate
```

#### Step 2: Update Version

```bash
# Choose appropriate version bump
npm version patch  # or minor, major
```

#### Step 3: Publish to npm

For the first publication:

```bash
npm publish --access public
```

For subsequent publications:

```bash
npm publish
```

The `prepublishOnly` script will automatically:
1. Run validation (`npm run validate`)
2. Clean build directory (`npm run clean`)
3. Build the package (`npm run build`)

#### Step 4: Push to Git

```bash
# Push commits and tags
git push origin main
git push origin --tags
```

### Publishing Pre-Release Versions

For beta, alpha, or RC versions:

```bash
# Create pre-release version
npm version prerelease --preid=beta

# Publish with beta tag
npm publish --tag beta
```

Users can install with:
```bash
npm install @adverant-nexus/cli@beta
```

---

## Post-Publication Verification

After publishing, verify everything works:

### 1. Check npm Registry

```bash
# View package info
npm view @adverant-nexus/cli

# View all versions
npm view @adverant-nexus/cli versions

# View latest version
npm view @adverant-nexus/cli version
```

### 2. Test Installation

```bash
# Create fresh test directory
mkdir /tmp/npm-test
cd /tmp/npm-test

# Install from npm
npm install -g @adverant-nexus/cli

# Test commands
nexus --version
nexus --help

# Cleanup
npm uninstall -g @adverant-nexus/cli
```

### 3. Verify Package Page

Visit your package page:
- https://www.npmjs.com/package/@adverant-nexus/cli

Check:
- [ ] README displays correctly
- [ ] Version number is correct
- [ ] Package size is shown
- [ ] Dependencies are listed
- [ ] Keywords are present

### 4. Test in Different Environments

Test installation on:
- [ ] Linux
- [ ] macOS
- [ ] Windows
- [ ] Different Node.js versions (18, 20, 22)

```bash
# Using nvm (Node Version Manager)
nvm use 18
npm install -g @adverant-nexus/cli
nexus --version

nvm use 20
npm install -g @adverant-nexus/cli
nexus --version
```

---

## Troubleshooting

### Common Issues

#### 1. "You do not have permission to publish"

**Problem**: Not authenticated or not a member of the organization.

**Solution**:
```bash
npm login
npm whoami  # Verify you're logged in
```

For scoped packages, ensure you're a member of `@adverant-nexus`.

#### 2. "Package name already exists"

**Problem**: Package name is taken.

**Solution**:
- Use a scoped package name: `@your-org/package-name`
- Choose a different name
- Contact npm support if you believe you own the name

#### 3. "Version already published"

**Problem**: You're trying to publish a version that already exists.

**Solution**:
```bash
# Bump version
npm version patch

# Then publish
npm publish
```

Note: You **cannot** overwrite a published version.

#### 4. "Validation failed"

**Problem**: Pre-publish validation found issues.

**Solution**:
```bash
# Run validation to see specific issues
npm run validate

# Fix each issue, then try again
npm publish
```

#### 5. "Missing dist/ directory"

**Problem**: Build artifacts not created.

**Solution**:
```bash
npm run clean
npm run build
npm publish
```

#### 6. "Package too large"

**Problem**: Package exceeds npm size limits or is unreasonably large.

**Solution**:
- Review `.npmignore` to exclude unnecessary files
- Remove source maps from production build
- Optimize dependencies
- Check for accidentally included `node_modules`

```bash
# See what's being included
npm pack --dry-run

# Check package size
npm pack
ls -lh *.tgz
```

#### 7. "Two-factor authentication required"

**Problem**: Your account requires 2FA for publishing.

**Solution**:
```bash
# Enable 2FA
npm profile enable-2fa auth-and-writes

# Publish (you'll be prompted for OTP)
npm publish
```

#### 8. "Invalid package.json"

**Problem**: Syntax error or missing required fields in package.json.

**Solution**:
- Validate JSON syntax
- Ensure required fields are present: name, version, description
- Check for typos in field names

```bash
# Validate package.json
node -e "console.log(require('./package.json'))"
```

---

## CI/CD Integration

Automate publishing with GitHub Actions or other CI/CD platforms.

### GitHub Actions Example

Create `.github/workflows/publish.yml`:

```yaml
name: Publish to npm

on:
  push:
    tags:
      - 'v*'

jobs:
  publish:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'

      - name: Install dependencies
        run: npm ci

      - name: Run validation
        run: npm run validate

      - name: Build
        run: npm run build

      - name: Publish to npm
        run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Create GitHub Release
        uses: actions/create-release@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tag_name: ${{ github.ref }}
          release_name: Release ${{ github.ref }}
          draft: false
          prerelease: false
```

### Setup Instructions

1. **Create npm Access Token**:
   - Go to npmjs.com → Profile → Access Tokens
   - Click "Generate New Token"
   - Choose "Automation" token type
   - Copy the token

2. **Add Token to GitHub**:
   - Go to your repository → Settings → Secrets and variables → Actions
   - Click "New repository secret"
   - Name: `NPM_TOKEN`
   - Value: paste your npm token
   - Click "Add secret"

3. **Trigger Publication**:
   ```bash
   # Create and push a version tag
   npm version patch
   git push origin main --tags
   ```

   The workflow will automatically:
   - Run validation
   - Build the package
   - Publish to npm
   - Create a GitHub release

### GitLab CI Example

Create `.gitlab-ci.yml`:

```yaml
publish:
  stage: deploy
  image: node:20
  only:
    - tags
  before_script:
    - npm ci
  script:
    - npm run validate
    - npm run build
    - echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > .npmrc
    - npm publish --access public
```

Add `NPM_TOKEN` to GitLab CI/CD variables:
- Go to Project → Settings → CI/CD → Variables
- Add variable: `NPM_TOKEN` (protected, masked)

---

## Best Practices

1. **Always test locally first**: Use `npm run verify` before publishing
2. **Use semantic versioning**: Follow semver strictly
3. **Write meaningful changelogs**: Document all changes
4. **Tag releases in git**: Create tags for each version
5. **Never unpublish**: Use deprecation instead
6. **Monitor downloads**: Track usage on npmjs.com
7. **Respond to issues**: Engage with community feedback
8. **Keep dependencies updated**: Regular maintenance
9. **Security audits**: Run `npm audit` regularly
10. **Backup your npm account**: Enable 2FA and keep recovery codes

---

## Quick Reference Commands

```bash
# Validation & Testing
npm run validate          # Run pre-publish validation
npm run verify           # Test package in clean environment
npm run publish:dry      # Dry run publication
npm run link:global      # Link globally for testing

# Version Management
npm version patch        # Bump patch version
npm version minor        # Bump minor version
npm version major        # Bump major version
npm version prerelease   # Bump prerelease version

# Publishing
npm publish              # Publish to npm
npm publish --tag beta   # Publish as beta
npm publish --dry-run    # Preview publication

# Post-Publication
npm view @adverant-nexus/cli           # View package info
npm view @adverant-nexus/cli versions  # List all versions
npm deprecate @adverant-nexus/cli@1.0.0 "Use version 2.0.0"  # Deprecate version

# Maintenance
npm audit                # Check for vulnerabilities
npm outdated             # Check for outdated dependencies
npm update               # Update dependencies
```

---

## Support

For issues or questions:

- **GitHub Issues**: https://github.com/adverant-ai/adverant-nexus/issues
- **npm Support**: https://www.npmjs.com/support
- **Documentation**: https://adverant-nexus.dev

---

## License

MIT License - see [LICENSE](./LICENSE) file for details.
