import { useState } from 'react';
import { mountPage } from '../../ui-page/harness';
import { SkillCategoryFilterBar } from '../../../src/renderer/features/skillhub/components/SkillCategoryFilterBar';

function CategoryFixture() {
  const [selected, setSelected] = useState('category-5');
  const categories = Array.from({ length: 12 }, (_, index) => ({
    slug: 'category-' + index,
    name: 'Category ' + index,
    count: 0,
    myCount: 0,
  }));
  return (
    <main className="min-h-screen bg-[var(--surface)] p-8 text-[var(--text-primary)]">
      <div data-testid="category-available-width" style={{ width: 560, maxWidth: '100%' }}>
        <SkillCategoryFilterBar categories={categories} selectedCategory={selected}
          allLabel="All" ariaLabel="Categories" onSelectCategory={setSelected} />
      </div>
    </main>
  );
}

mountPage({ render: () => <CategoryFixture /> });
