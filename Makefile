.PHONY: help install dev docker-up docker-down docker-logs deploy test icons

help:
	@echo "KoalaChat"
	@echo ""
	@echo "  make install     Install Python dependencies"
	@echo "  make dev         Run local dev server (HTTP, port 8999)"
	@echo "  make docker-up   Start production Docker stack"
	@echo "  make docker-down Stop Docker stack"
	@echo "  make docker-logs Tail container logs"
	@echo "  make test        Run backend smoke tests"
	@echo "  make icons       Regenerate PWA icons"
	@echo "  make deploy      Deploy via deploy.sh"

install:
	pip install -r backend/requirements.txt

dev:
	cd backend && python -m uvicorn main:app --host 127.0.0.1 --port 8999 --reload

docker-up:
	docker compose up -d --build

docker-down:
	docker compose down

docker-logs:
	docker compose logs -f

test:
	pip install httpx -q
	cd backend && python -c "from main import app; from fastapi.testclient import TestClient; c = TestClient(app); assert c.get('/health').json()['status'] == 'ok'"

icons:
	python scripts/generate_icons.py

logo:
	python scripts/generate_icons.py

deploy:
	python scripts/generate_icons.py
	sh deploy.sh