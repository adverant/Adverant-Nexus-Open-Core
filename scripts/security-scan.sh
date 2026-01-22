#!/bin/bash
set -e

echo "========================================="
echo "Adverant Nexus Open Core - Security Scan"
echo "========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

ISSUES_FOUND=0

echo "1. Checking for hardcoded API keys..."
if grep -rn "sk-ant-api03\|sk-proj-[A-Za-z0-9]\|sk-or-v1-[A-Za-z0-9]\|AIzaSy[A-Za-z0-9]\|GOCSPX-[A-Za-z0-9]" packages/*/src services/*/src --include="*.ts" --include="*.js" 2>/dev/null; then
  echo -e "${RED}❌ CRITICAL: Hardcoded API keys found${NC}"
  ISSUES_FOUND=$((ISSUES_FOUND + 1))
else
  echo -e "${GREEN}✅ No hardcoded API keys detected${NC}"
fi
echo ""

echo "2. Checking for server IPs..."
if grep -rn "157\.173\.102\.118\|168\.231\.78\.181" . --include="*.ts" --include="*.js" --include="*.md" 2>/dev/null; then
  echo -e "${RED}❌ CRITICAL: Production server IPs found${NC}"
  ISSUES_FOUND=$((ISSUES_FOUND + 1))
else
  echo -e "${GREEN}✅ No server IPs detected${NC}"
fi
echo ""

echo "3. Checking for .env files in git..."
if find . -name ".env" -o -name ".env.local" -o -name ".env.production" 2>/dev/null | grep -v node_modules; then
  echo -e "${RED}❌ CRITICAL: .env files found in repository${NC}"
  ISSUES_FOUND=$((ISSUES_FOUND + 1))
else
  echo -e "${GREEN}✅ No .env files tracked${NC}"
fi
echo ""

echo "4. Checking for database passwords..."
if grep -rn "password.*=.*['\"][^'\"]\{8,\}['\"]" packages/*/src services/*/src --include="*.ts" --include="*.js" 2>/dev/null | grep -v "process.env" | grep -v "placeholder" | grep -v "example" | grep -v "// "; then
  echo -e "${YELLOW}⚠️  WARNING: Possible hardcoded passwords found${NC}"
  ISSUES_FOUND=$((ISSUES_FOUND + 1))
else
  echo -e "${GREEN}✅ No hardcoded passwords detected${NC}"
fi
echo ""

echo "5. Checking for JWT secrets..."
if grep -rn "jwt.*secret.*=.*['\"][^'\"]\{20,\}['\"]" packages/ services/ --include="*.ts" --include="*.js" 2>/dev/null | grep -v "process.env"; then
  echo -e "${RED}❌ CRITICAL: Hardcoded JWT secrets found${NC}"
  ISSUES_FOUND=$((ISSUES_FOUND + 1))
else
  echo -e "${GREEN}✅ No hardcoded JWT secrets detected${NC}"
fi
echo ""

echo "6. Running npm audit..."
if npm audit --audit-level=high 2>/dev/null; then
  echo -e "${GREEN}✅ No high/critical npm vulnerabilities${NC}"
else
  echo -e "${YELLOW}⚠️  WARNING: npm vulnerabilities found (run 'npm audit' for details)${NC}"
fi
echo ""

echo "========================================="
if [ $ISSUES_FOUND -eq 0 ]; then
  echo -e "${GREEN}✅ Security scan passed - No critical issues found${NC}"
  echo "========================================="
  exit 0
else
  echo -e "${RED}❌ Security scan failed - $ISSUES_FOUND issue(s) found${NC}"
  echo "========================================="
  exit 1
fi
