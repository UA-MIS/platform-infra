# Initial migration for the sample Item model. Apply with `bin/rails db:migrate` at
# deploy time (see MIGRATIONS.md), NOT from the app process. String columns are
# length-bounded because MySQL requires an explicit length on VARCHAR.
class CreateItems < ActiveRecord::Migration[8.1]
  def change
    create_table :items do |t|
      t.string :name, null: false, limit: 255, index: true
      t.string :description, limit: 1024

      t.timestamps
    end
  end
end
