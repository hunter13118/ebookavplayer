.PHONY: install api web sample test
install:
	pip install -r requirements.txt
	cd web && npm install
api:
	uvicorn server.app:app --host 0.0.0.0 --port 8600 --reload --reload-dir server
web:
	cd web && npm run dev
sample:
	python3 -m server.sample.build_sample
test:
	python3 -m pytest tests -q
test-offline:
	python3 -m pytest tests/test_offline_pack.py -q
test-web:
	cd web && npm test
test-e2e-offline:
	cd web && npm run test:install && npx playwright test tests/e2e/offline-pack.spec.js
