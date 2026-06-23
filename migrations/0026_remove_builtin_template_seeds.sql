DELETE FROM page_templates WHERE id IN ('kuro-boo-side','minimal','magazine','portfolio','monetize','diary') AND is_active = 0;
DELETE FROM page_templates WHERE id = 'kuro-boo';
