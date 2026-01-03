## Description

<!-- Provide a clear and concise description of your changes -->

## Related Issues

<!-- Reference any related issues this PR addresses -->
Fixes #(issue_number)
Relates to #(issue_number)

## Type of Change

Please check the relevant option(s):

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update
- [ ] Refactoring (no functional changes, no API changes)
- [ ] Performance improvement
- [ ] Test addition/improvement
- [ ] Build/CI configuration change
- [ ] Other (please describe):

## Testing

<!-- Describe the tests you ran to verify your changes -->

- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] Manual testing performed
- [ ] All existing tests pass

**Test Configuration**:
- Node version:
- OS:
- Database versions (if applicable):

**Test Results**:
```
<!-- Paste test output here -->
```

## Checklist

Please confirm you have completed the following:

### Code Quality
- [ ] My code follows the project's code style guidelines
- [ ] I have performed a self-review of my code
- [ ] I have commented my code, particularly in hard-to-understand areas
- [ ] I have removed any debugging code (console.log, debugger, etc.)
- [ ] I have avoided introducing new dependencies unless necessary

### Documentation
- [ ] I have made corresponding changes to the documentation
- [ ] I have updated relevant README files
- [ ] I have added/updated JSDoc comments for new functions/classes
- [ ] I have updated the CHANGELOG.md (if applicable)

### Testing
- [ ] I have added tests that prove my fix is effective or that my feature works
- [ ] New and existing unit tests pass locally with my changes
- [ ] I have run `npm run lint` and fixed any issues
- [ ] I have run `npm run typecheck` and fixed any type errors

### Security & Best Practices
- [ ] My changes do not introduce security vulnerabilities
- [ ] I have validated user inputs appropriately
- [ ] I have used parameterized queries for database operations
- [ ] I have not committed sensitive information (API keys, passwords, etc.)

### Breaking Changes
- [ ] This PR does NOT introduce breaking changes
- [ ] OR I have documented breaking changes and migration path below

## Breaking Changes

<!-- If this PR introduces breaking changes, describe them and provide migration instructions -->

**Migration Guide**:
```
<!-- Describe how users should update their code -->
```

## Screenshots/Videos

<!-- If applicable, add screenshots or videos to demonstrate the changes -->

## Performance Impact

<!-- Describe any performance implications of your changes -->

- [ ] No performance impact
- [ ] Performance improved (provide benchmarks below)
- [ ] Minor performance regression (justified by benefits)
- [ ] Significant performance impact (describe mitigation)

**Benchmarks** (if applicable):
```
<!-- Paste benchmark results here -->
```

## Deployment Notes

<!-- Any special deployment considerations? -->

- [ ] No special deployment steps required
- [ ] Requires database migration (describe below)
- [ ] Requires configuration changes (describe below)
- [ ] Requires dependency updates (describe below)

**Deployment Instructions**:
```
<!-- Special deployment steps -->
```

## Reviewers

<!-- @ mention specific reviewers if needed, otherwise CODEOWNERS will auto-assign -->

## Additional Notes

<!-- Any additional information for reviewers -->

---

**Reviewer Checklist** (for maintainers):

- [ ] Code quality meets project standards
- [ ] Tests are adequate and pass
- [ ] Documentation is updated
- [ ] No security concerns
- [ ] Performance impact is acceptable
- [ ] Breaking changes are justified and documented
- [ ] CHANGELOG.md updated (if needed)
