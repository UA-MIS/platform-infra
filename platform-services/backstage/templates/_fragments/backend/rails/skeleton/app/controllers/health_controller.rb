# HealthController — DB-independent endpoints.
#
#   GET /healthz, /health : 200 {"status":"ok"} — liveness/readiness; never touches the
#                           database (the platform probes call this).
#   GET /                  : 200 — proves APP_SECRET was read WITHOUT echoing it.
require "digest"

class HealthController < ApplicationController
  def show
    render json: { status: "ok" }
  end

  def root
    secret = ENV["APP_SECRET"].to_s
    render json: {
      app: "${{ values.appName }}",
      secret_loaded: !secret.empty?,
      secret_length: secret.length,
      secret_sha256_prefix: Digest::SHA256.hexdigest(secret)[0, 8],
    }
  end
end
