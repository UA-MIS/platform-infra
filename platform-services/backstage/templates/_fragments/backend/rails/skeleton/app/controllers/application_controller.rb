class ApplicationController < ActionController::API
  # Degrade rule (the backend contract): when the database is unavailable — DATABASE_URL
  # unset (no usable connection) or the DB unreachable — the data routes must return a
  # clear 503 while /healthz stays 200. Translate the relevant Active Record connection
  # errors into a 503 here so every controller inherits it.
  rescue_from ActiveRecord::ConnectionNotEstablished,
              ActiveRecord::NoDatabaseError,
              ActiveRecord::DatabaseConnectionError,
              ActiveRecord::StatementInvalid,
              with: :database_unavailable

  private

  def database_unavailable
    render json: {
      error: "database unavailable: DATABASE_URL is not set or the database is unreachable",
    }, status: :service_unavailable
  end
end
