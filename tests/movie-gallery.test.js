import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMovieGallery} from '../movie-gallery.js';

test('gallery includes every poster and backdrop without duplicates', () => {
  const movie = {
    poster_path: '/poster.jpg', backdrop_path: '/scene.jpg',
    images: {posters: [{file_path: '/poster.jpg'}, {file_path: '/alternative.jpg'}], backdrops: [{file_path: '/scene.jpg'}, {file_path: '/scene2.jpg'}]}
  };
  assert.deepEqual(buildMovieGallery(movie, '/alternative.jpg').map(item => item.path), ['/alternative.jpg', '/poster.jpg', '/scene.jpg', '/scene2.jpg']);
});

test('missing or malformed images never create broken gallery entries', () => {
  assert.deepEqual(buildMovieGallery({images: {posters: [{}, {file_path: 'https://example.com/image.jpg'}, {file_path: '/bad"path.jpg'}]}}), []);
  assert.deepEqual(buildMovieGallery({backdrop_path: '/scene.jpg'}), [{path: '/scene.jpg', label: 'Image du film'}]);
});

test('a personal cover remains available even if removed from TMDB image results', () => {
  assert.equal(buildMovieGallery({poster_path: '/default.jpg', images: {}}, '/personal.jpg')[0].path, '/personal.jpg');
});
