/**
 * OAuth Authentication Routes
 *
 * Endpoints for Google OAuth 2.0 authentication flow
 */

import { Router, Request, Response } from 'express';
import { GoogleOAuthManager } from '../auth/google-oauth-manager.js';
import { logger } from '../utils/logger.js';

export function createAuthRoutes(oauthManager: GoogleOAuthManager): Router {
  const router = Router();

  /**
   * GET /auth/google/login
   *
   * Initiate OAuth 2.0 authentication flow
   * Redirects user to Google consent screen
   */
  router.get('/google/login', (req: Request, res: Response) => {
    try {
      const authUrl = oauthManager.getAuthorizationUrl();

      logger.info('Initiating Google OAuth flow', { authUrl });

      // Return HTML page with redirect or JSON for API clients
      if (req.headers.accept?.includes('text/html')) {
        return res.send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Google Drive Authentication</title>
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              }
              .container {
                background: white;
                padding: 3rem;
                border-radius: 12px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                text-align: center;
                max-width: 500px;
              }
              h1 {
                color: #333;
                margin-bottom: 1rem;
              }
              p {
                color: #666;
                margin-bottom: 2rem;
                line-height: 1.6;
              }
              .btn {
                display: inline-block;
                padding: 12px 32px;
                background: #4285f4;
                color: white;
                text-decoration: none;
                border-radius: 6px;
                font-weight: 600;
                transition: background 0.3s;
              }
              .btn:hover {
                background: #357ae8;
              }
              .info {
                margin-top: 2rem;
                padding: 1rem;
                background: #f8f9fa;
                border-radius: 6px;
                font-size: 0.9rem;
                color: #666;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>🔐 Google Drive Authentication</h1>
              <p>
                Click the button below to authenticate with your Google account.
                This will grant GraphRAG service read-only access to your Google Drive files.
              </p>
              <a href="${authUrl}" class="btn">
                Authenticate with Google
              </a>
              <div class="info">
                <strong>Permissions requested:</strong>
                <ul style="text-align: left; margin: 0.5rem 0 0 1.5rem;">
                  <li>View and download your Google Drive files</li>
                  <li>View metadata of your Drive files</li>
                </ul>
              </div>
            </div>
          </body>
          </html>
        `);
      } else {
        return res.json({
          success: true,
          authUrl,
          message: 'Visit the authUrl to authenticate with Google'
        });
      }
    } catch (error) {
      logger.error('Failed to initiate OAuth flow', {
        error: (error as Error).message
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to initiate authentication',
        message: (error as Error).message
      });
    }
  });

  /**
   * GET /auth/google/callback
   *
   * OAuth callback endpoint
   * Exchanges authorization code for access tokens
   */
  router.get('/google/callback', async (req: Request, res: Response) => {
    try {
      const { code, error, error_description } = req.query;

      // Check for OAuth errors
      if (error) {
        logger.error('OAuth callback received error', {
          error,
          error_description
        });

        return res.status(400).send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Authentication Failed</title>
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
                background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
              }
              .container {
                background: white;
                padding: 3rem;
                border-radius: 12px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                text-align: center;
                max-width: 500px;
              }
              h1 {
                color: #d32f2f;
                margin-bottom: 1rem;
              }
              p {
                color: #666;
                line-height: 1.6;
              }
              .error-code {
                background: #ffebee;
                padding: 1rem;
                border-radius: 6px;
                margin-top: 1rem;
                font-family: monospace;
                color: #c62828;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>❌ Authentication Failed</h1>
              <p>Google OAuth authentication was not successful.</p>
              <div class="error-code">
                <strong>Error:</strong> ${error}<br>
                ${error_description ? `<strong>Details:</strong> ${error_description}` : ''}
              </div>
            </div>
          </body>
          </html>
        `);
      }

      // Validate authorization code
      if (!code || typeof code !== 'string') {
        logger.error('No authorization code received');

        return res.status(400).json({
          success: false,
          error: 'No authorization code received'
        });
      }

      // Exchange code for tokens
      logger.info('Exchanging authorization code for tokens');
      const tokens = await oauthManager.exchangeCodeForTokens(code);

      logger.info('OAuth authentication successful', {
        hasRefreshToken: !!tokens.refresh_token
      });

      // Return success page
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Authentication Successful</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              height: 100vh;
              margin: 0;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            }
            .container {
              background: white;
              padding: 3rem;
              border-radius: 12px;
              box-shadow: 0 20px 60px rgba(0,0,0,0.3);
              text-align: center;
              max-width: 500px;
            }
            h1 {
              color: #4caf50;
              margin-bottom: 1rem;
            }
            p {
              color: #666;
              line-height: 1.6;
              margin-bottom: 1rem;
            }
            .success-icon {
              font-size: 4rem;
              margin-bottom: 1rem;
            }
            .info {
              background: #e8f5e9;
              padding: 1rem;
              border-radius: 6px;
              margin-top: 1.5rem;
              font-size: 0.9rem;
              color: #2e7d32;
            }
            .close-btn {
              margin-top: 1.5rem;
              padding: 10px 24px;
              background: #4caf50;
              color: white;
              border: none;
              border-radius: 6px;
              font-weight: 600;
              cursor: pointer;
            }
            .close-btn:hover {
              background: #45a049;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="success-icon">✅</div>
            <h1>Authentication Successful!</h1>
            <p>
              Your Google account has been successfully authenticated.
              GraphRAG service can now access your Google Drive files.
            </p>
            <div class="info">
              <strong>✓ Authentication Complete</strong><br>
              You can now close this window and use the URL ingestion feature.
            </div>
            <button class="close-btn" onclick="window.close()">Close Window</button>
          </div>
        </body>
        </html>
      `);
    } catch (error) {
      logger.error('OAuth callback failed', {
        error: (error as Error).message,
        stack: (error as Error).stack
      });

      return res.status(500).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Authentication Error</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              height: 100vh;
              margin: 0;
              background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            }
            .container {
              background: white;
              padding: 3rem;
              border-radius: 12px;
              box-shadow: 0 20px 60px rgba(0,0,0,0.3);
              text-align: center;
              max-width: 500px;
            }
            h1 {
              color: #d32f2f;
              margin-bottom: 1rem;
            }
            p {
              color: #666;
              line-height: 1.6;
            }
            .error-code {
              background: #ffebee;
              padding: 1rem;
              border-radius: 6px;
              margin-top: 1rem;
              font-family: monospace;
              color: #c62828;
              font-size: 0.9rem;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>⚠️ Authentication Error</h1>
            <p>An error occurred while processing your authentication.</p>
            <div class="error-code">
              ${(error as Error).message}
            </div>
            <p style="margin-top: 1.5rem;">
              Please try again or contact support if the problem persists.
            </p>
          </div>
        </body>
        </html>
      `);
    }
  });

  /**
   * GET /auth/google/status
   *
   * Check OAuth authentication status
   */
  router.get('/google/status', async (_req: Request, res: Response) => {
    try {
      const isAuthenticated = await oauthManager.isAuthenticated();

      return res.json({
        success: true,
        authenticated: isAuthenticated,
        message: isAuthenticated
          ? 'Google Drive authentication active'
          : 'Not authenticated. Visit /auth/google/login to authenticate'
      });
    } catch (error) {
      logger.error('Failed to check authentication status', {
        error: (error as Error).message
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to check authentication status'
      });
    }
  });

  /**
   * POST /auth/google/logout
   *
   * Clear stored OAuth tokens
   */
  router.post('/google/logout', async (_req: Request, res: Response) => {
    try {
      await oauthManager.clearTokens();

      logger.info('OAuth tokens cleared');

      return res.json({
        success: true,
        message: 'Successfully logged out from Google Drive'
      });
    } catch (error) {
      logger.error('Failed to logout', {
        error: (error as Error).message
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to logout'
      });
    }
  });

  return router;
}
