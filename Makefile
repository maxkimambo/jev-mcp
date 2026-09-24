.PHONY: build test lint e2e

build:
	npm run build

test: build
	npm test

lint:
	npm run typecheck

# Live tests against the real API; needs TYPESAFE_API_KEY (an OpenRouter sk-or- key works).
e2e: build
	npm run test:e2e
