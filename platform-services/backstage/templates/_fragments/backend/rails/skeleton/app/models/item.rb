# Item — a sample model so the CRUD API has something to persist. Replace it with your
# own domain models. `name` is required.
class Item < ApplicationRecord
  validates :name, presence: true, length: { maximum: 255 }
  validates :description, length: { maximum: 1024 }, allow_nil: true
end
