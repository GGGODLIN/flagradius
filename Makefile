.PHONY: demo test test-live-e2e typecheck

demo:
	npm run demo

test:
	npm test

test-live-e2e:
	npm run test:live-e2e

typecheck:
	npm run typecheck
