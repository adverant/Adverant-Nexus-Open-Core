#!/bin/bash
set -e

echo "========================================"
echo "MageAgent Local Testing"
echo "========================================"

# Load environment variables
if [ -f .env.test ]; then
    export $(cat .env.test | grep -v '^#' | xargs)
    echo "✅ Loaded test environment variables"
else
    echo "❌ .env.test file not found"
    exit 1
fi

# Check if API keys are set
if [ -z "$OPENROUTER_API_KEY" ] || [ -z "$VOYAGE_API_KEY" ]; then
    echo "❌ API keys not found in environment"
    exit 1
fi

echo "✅ API Keys configured:"
echo "   OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:0:20}..."
echo "   VOYAGE_API_KEY: ${VOYAGE_API_KEY:0:20}..."

# Function to test local service
test_local_service() {
    echo -e "\n🧪 Testing Local Service..."

    # Start the service in background
    echo "Starting MageAgent service locally..."
    npm run dev > service.log 2>&1 &
    SERVICE_PID=$!

    # Wait for service to start
    echo "Waiting for service to start..."
    sleep 10

    # Test health endpoint
    echo -e "\n📍 Testing health endpoint..."
    if curl -s http://localhost:8080/api/health | jq .; then
        echo "✅ Health check passed"
    else
        echo "❌ Health check failed"
        cat service.log
        kill $SERVICE_PID 2>/dev/null || true
        exit 1
    fi

    # Test memory storage with real API
    echo -e "\n📍 Testing memory storage (using real APIs)..."
    TEST_ID=$(date +%s)
    curl -X POST http://localhost:8080/api/memory \
        -H "Content-Type: application/json" \
        -d "{
            \"content\": \"Local test memory $TEST_ID\",
            \"tags\": [\"test\", \"local\"],
            \"metadata\": {\"test_id\": \"$TEST_ID\"}
        }" | jq .

    # Test orchestration with real OpenRouter
    echo -e "\n📍 Testing orchestration (using real OpenRouter API)..."
    curl -X POST http://localhost:8080/api/orchestrate \
        -H "Content-Type: application/json" \
        -d '{
            "task": "Say hello world",
            "options": {
                "models": ["openai/gpt-3.5-turbo"]
            }
        }' | jq .

    # Stop the service
    echo -e "\n🛑 Stopping service..."
    kill $SERVICE_PID 2>/dev/null || true

    echo -e "\n✅ Local testing complete!"
}

# Function to build and test Docker image
test_docker_image() {
    echo -e "\n🐳 Testing Docker Image..."

    # Build the image
    echo "Building Docker image..."
    docker build -t mageagent:test .

    # Run container
    echo "Running Docker container..."
    docker run -d \
        --name mageagent-test \
        -p 8080:8080 \
        -e OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
        -e VOYAGE_API_KEY="$VOYAGE_API_KEY" \
        -e NODE_ENV=development \
        -e LOG_LEVEL=debug \
        mageagent:test

    # Wait for container to start
    echo "Waiting for container to start..."
    sleep 15

    # Test health endpoint
    echo -e "\n📍 Testing containerized service..."
    if curl -s http://localhost:8080/api/health | jq .; then
        echo "✅ Container health check passed"
    else
        echo "❌ Container health check failed"
        docker logs mageagent-test
    fi

    # Stop and remove container
    echo -e "\n🛑 Cleaning up..."
    docker stop mageagent-test
    docker rm mageagent-test

    echo -e "\n✅ Docker testing complete!"
}

# Main menu
echo -e "\nSelect test type:"
echo "1) Test local Node.js service"
echo "2) Test Docker container"
echo "3) Run both tests"

read -p "Enter your choice (1-3): " choice

case $choice in
    1)
        test_local_service
        ;;
    2)
        test_docker_image
        ;;
    3)
        test_local_service
        test_docker_image
        ;;
    *)
        echo "Invalid choice"
        exit 1
        ;;
esac

echo -e "\n========================================"
echo "Testing Complete!"
echo "========================================"