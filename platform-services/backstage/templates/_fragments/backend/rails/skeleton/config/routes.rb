Rails.application.routes.draw do
  # DB-INDEPENDENT health probe. The platform chart's liveness/readiness probes hit
  # /healthz directly on the pod, so it must stay 200 with no database.
  get "healthz" => "health#show"
  get "health" => "health#show"

  # Root: proves APP_SECRET was read without echoing it.
  root "health#root"

  # The sample API. Mounted under /api so the platform ingress (/api -> this backend)
  # reaches it: /api/items and /api/items/:id.
  namespace :api do
    resources :items, only: %i[index show create update destroy]
  end
end
