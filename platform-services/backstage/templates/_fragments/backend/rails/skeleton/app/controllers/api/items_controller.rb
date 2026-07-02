# Api::ItemsController — sample CRUD over the Item model, mounted at /api/items.
# This is the pattern to copy for your own resources. DB-connection failures are turned
# into a 503 by ApplicationController#database_unavailable (the degrade contract).
module Api
  class ItemsController < ApplicationController
    before_action :set_item, only: %i[show update destroy]

    # GET /api/items
    def index
      render json: Item.order(:id)
    end

    # GET /api/items/:id
    def show
      render json: @item
    end

    # POST /api/items
    def create
      item = Item.new(item_params)
      if item.save
        render json: item, status: :created
      else
        render json: { errors: item.errors }, status: :unprocessable_entity
      end
    end

    # PUT/PATCH /api/items/:id
    def update
      if @item.update(item_params)
        render json: @item
      else
        render json: { errors: @item.errors }, status: :unprocessable_entity
      end
    end

    # DELETE /api/items/:id
    def destroy
      @item.destroy
      head :no_content
    end

    private

    def set_item
      @item = Item.find_by(id: params[:id])
      head :not_found if @item.nil?
    end

    def item_params
      params.require(:item).permit(:name, :description)
    end
  end
end
