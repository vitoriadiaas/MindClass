// Dados fixos da escola.

// Horários padrão de cada "aula" do dia (1ª aula, 2ª aula…). Cada turma usa as primeiras N.
export const SLOTS = [
  ['07:00', '07:50'], ['07:50', '08:40'], ['08:40', '09:30'],   // intervalo 09:30–09:50
  ['09:50', '10:40'], ['10:40', '11:30'], ['11:30', '12:20'],   // almoço 12:20–13:30
  ['13:30', '14:20'], ['14:20', '15:10'], ['15:10', '16:00'],
];

export const TURMAS_OFICIAIS = [
  ['6º ano A', 'fundamental', 5], ['6º ano B', 'fundamental', 5], ['7º ano A', 'fundamental', 5], ['7º ano B', 'fundamental', 5],
  ['8º ano A', 'fundamental', 5], ['8º ano B', 'fundamental', 5], ['9º ano A', 'fundamental', 5], ['9º ano B', 'fundamental', 5],
  ['1º ano Administração', 'medio', 7], ['1º ano Agronegócio', 'medio', 9], ['2º ano Alimentos', 'medio', 9],
  ['3º ano Informática', 'medio', 9], ['3º ano Regular', 'medio', 6],
];

export const MATERIAS = ['Matemática', 'Português', 'História', 'Geografia', 'Biologia', 'Física', 'Química', 'Inglês', 'Educação Física', 'Informática', 'Artes', 'Filosofia', 'Sociologia'];
